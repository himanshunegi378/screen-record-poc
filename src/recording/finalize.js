const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { config } = require('../config');
const { appendFileToStream } = require('../utils/files');
const { getSessionDir } = require('../utils/paths');
const { getOrderedChunks } = require('./chunks');

/**
 * Tracks sessions that are currently undergoing the finalization (stitching) process.
 * Used to avoid concurrent write access to final-recording file.
 * @type {Set<string>}
 */
const finalizationInProgress = new Set();
const WEBM_EBML_HEADER = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/**
 * Checks whether a file starts with a WebM/Matroska EBML header.
 *
 * @param {string} filePath - Path to the candidate WebM file.
 * @returns {boolean} True when the file starts with the EBML header.
 */
function hasWebmHeader(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(WEBM_EBML_HEADER.length);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    fs.closeSync(fd);
    return bytesRead === WEBM_EBML_HEADER.length && header.equals(WEBM_EBML_HEADER);
  } catch (error) {
    return false;
  }
}

/**
 * Writes stitch failure details so quiet-session cron does not retry the same
 * unfixable chunk set forever.
 *
 * @param {string} sessionDir - Directory of the session.
 * @param {string} sessionId - The ID of the session.
 * @param {object[]} chunkFiles - Sorted list of chunk file info objects.
 * @param {string} reason - Machine-readable failure reason.
 * @param {string} message - Human-readable failure message.
 * @param {string} trigger - Finalization trigger.
 * @returns {void}
 */
function writeStitchFailureState(sessionDir, sessionId, chunkFiles, reason, message, trigger) {
  const stateFile = path.join(sessionDir, 'stitch_state.json');
  const eventFile = path.join(sessionDir, 'events.jsonl');
  const failedAt = new Date().toISOString();
  const stateData = {
    status: 'failed',
    reason,
    message,
    lastAttemptedAt: failedAt,
    stitchedChunks: chunkFiles.map(c => c.filename)
  };

  const finalEvent = {
    sessionId,
    type: 'final_recording_failed',
    timestamp: failedAt,
    metadata: {
      reason,
      message,
      mergedChunksCount: chunkFiles.length,
      trigger
    }
  };

  try {
    fs.writeFileSync(stateFile, JSON.stringify(stateData, null, 2), 'utf8');
    fs.appendFileSync(eventFile, JSON.stringify(finalEvent) + '\n', 'utf8');
    console.log(`[FINALIZATION STATE] Saved failed stitch_state.json for session: ${sessionId}`);
  } catch (error) {
    console.error(`[FINALIZATION ERROR] Failed to save stitch failure state for session ${sessionId}:`, error);
  }
}

/**
 * Consolidates all ordered chunk files into a single temporary webm file,
 * and then safely renames it to the output target.
 *
 * @param {string} sessionDir - Directory of the session.
 * @param {object[]} chunkFiles - Sorted list of chunk file info objects.
 * @returns {Promise<string>} Promise resolving to the output file path.
 */
function writeMergedRecording(sessionDir, chunkFiles) {
  const tempFilePath = path.join(sessionDir, 'final-recording.raw.webm.tmp');

  return new Promise(async (resolve, reject) => {
    const outputStream = fs.createWriteStream(tempFilePath);

    outputStream.on('error', reject);

    try {
      for (const chunk of chunkFiles) {
        await appendFileToStream(path.join(sessionDir, chunk.filename), outputStream);
      }

      outputStream.end();
      outputStream.on('finish', () => resolve(tempFilePath));
    } catch (error) {
      outputStream.destroy();
      fs.rm(tempFilePath, { force: true }, () => reject(error));
    }
  });
}

/**
 * Deletes the individual source chunk files to clean up disk space.
 *
 * @param {string} sessionDir - Directory of the session.
 * @param {object[]} chunkFiles - Array of chunk files to clean up.
 * @returns {void}
 */
function cleanupChunkFiles(sessionDir, chunkFiles) {
  for (const chunk of chunkFiles) {
    fs.rm(path.join(sessionDir, chunk.filename), { force: true }, (error) => {
      if (error) {
        console.warn(`[CHUNK CLEANUP WARNING] Failed to delete ${chunk.filename}:`, error);
      }
    });
  }
}

/**
 * Invokes FFmpeg to remux the WebM video. This regenerates presentation timestamps (PTS)
 * and metadata so that the final video duration reports correctly in players.
 *
 * @param {string} sessionDir - Working directory for execution.
 * @param {string} inputFilePath - Path to the merged webm file.
 * @returns {Promise<string>} Promise resolving to the remuxed input file path.
 */
function remuxWebmDuration(sessionDir, inputFilePath, outputFilePath) {
  const remuxedFilePath = path.join(sessionDir, 'final-recording.remuxed.webm.tmp');

  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-y', '-fflags', '+genpts', '-i', inputFilePath, '-c', 'copy', '-cues_to_front', '1', '-f', 'webm', remuxedFilePath],
      { cwd: sessionDir },
      (error, stdout, stderr) => {
        if (error) {
          fs.rm(remuxedFilePath, { force: true }, () => {});
          reject(new Error(stderr || error.message));
          return;
        }

        fs.rename(remuxedFilePath, outputFilePath, (renameErr) => {
          if (renameErr) {
            reject(renameErr);
            return;
          }

          fs.rm(inputFilePath, { force: true }, () => resolve(outputFilePath));
        });
      }
    );
  });
}

/**
 * Reads session chunks, concatenates them, updates WebM metadata via FFmpeg,
 * logs a finalization event, and optionally deletes the raw chunk source files.
 *
 * @param {string} sessionId - The ID of the session.
 * @param {object} [options={}] - Execution options.
 * @returns {void}
 */
function finalizeSession(sessionId, options = {}) {
  const deleteChunks = options.deleteChunks === true;
  const trigger = options.trigger || 'manual';
  const sessionDir = getSessionDir(sessionId);

  if (finalizationInProgress.has(sessionId)) {
    console.log(`[FINALIZATION SKIPPED] Stitching already in progress for session: ${sessionId}`);
    return;
  }

  console.log(`[FINALIZATION START] Beginning consolidation for session: ${sessionId}, trigger: ${trigger}`);
  finalizationInProgress.add(sessionId);

  function finishFinalization() {
    finalizationInProgress.delete(sessionId);
  }

  fs.readdir(sessionDir, (err, files) => {
    if (err) {
      console.error(`[FINALIZATION ERROR] Failed to read directory for session ${sessionId}:`, err);
      finishFinalization();
      return;
    }

    const chunkFiles = getOrderedChunks(sessionDir);

    if (chunkFiles.length === 0) {
      console.log(`[FINALIZATION SKIPPED] No chunks found to consolidate for session: ${sessionId}`);
      finishFinalization();
      return;
    }

    console.log(
      `[FINALIZATION ORDER] ${chunkFiles
        .map(chunk => `${chunk.filename}${chunk.startTime !== null ? `@${chunk.startTime}s` : ''}`)
        .join(' -> ')}`
    );

    const outputFilePath = path.join(sessionDir, 'final-recording.webm');
    const hadFinalRecording = fs.existsSync(outputFilePath);
    const firstChunkPath = path.join(sessionDir, chunkFiles[0].filename);

    if (!hasWebmHeader(firstChunkPath)) {
      const message = `First available chunk ${chunkFiles[0].filename} does not contain a WebM header. The initial MediaRecorder chunk is missing, so the remaining chunks cannot be remuxed into a valid final recording.`;
      console.error(`[FINALIZATION ERROR] ${message}`);
      fs.rm(outputFilePath, { force: true }, () => {});
      writeStitchFailureState(sessionDir, sessionId, chunkFiles, 'missing_initial_webm_header', message, trigger);
      finishFinalization();
      return;
    }

    writeMergedRecording(sessionDir, chunkFiles)
      .then((mergedRecordingPath) => remuxWebmDuration(sessionDir, mergedRecordingPath, outputFilePath))
      .then((finalRecordingPath) => {
        console.log(`[FINALIZATION SUCCESS] Video saved for session: ${sessionId}`);

        const eventFile = path.join(sessionDir, 'events.jsonl');
        const finalEvent = {
          sessionId: sessionId,
          type: hadFinalRecording ? 'final_recording_updated' : 'final_recording_created',
          timestamp: new Date().toISOString(),
          metadata: {
            outputFile: 'final-recording.webm',
            mergedChunksCount: chunkFiles.length,
            totalSize: fs.existsSync(finalRecordingPath) ? fs.statSync(finalRecordingPath).size : 0,
            trigger,
            deletedMergedChunks: deleteChunks
          }
        };

        const stateFile = path.join(sessionDir, 'stitch_state.json');
        const stateData = {
          status: 'success',
          lastStitchedAt: new Date().toISOString(),
          stitchedChunks: chunkFiles.map(c => c.filename),
          totalSize: finalEvent.metadata.totalSize
        };

        try {
          fs.writeFileSync(stateFile, JSON.stringify(stateData, null, 2), 'utf8');
          console.log(`[FINALIZATION STATE] Saved stitch_state.json for session: ${sessionId}`);
        } catch (stateErr) {
          console.error(`[FINALIZATION ERROR] Failed to save stitch_state.json for session ${sessionId}:`, stateErr);
        }

        fs.appendFile(eventFile, JSON.stringify(finalEvent) + '\n', 'utf8', (appendErr) => {
          if (appendErr) {
            console.error(`[FINALIZATION ERROR] Failed to log ${finalEvent.type} event for session ${sessionId}:`, appendErr);
          } else {
            console.log(`[FINALIZATION EVENT] Appended ${finalEvent.type} event for session: ${sessionId}`);
          }

          if (deleteChunks) {
            cleanupChunkFiles(sessionDir, chunkFiles);
          }

          finishFinalization();
        });
      })
      .catch((error) => {
        console.error(`[FINALIZATION ERROR] Failed to rebuild rolling final recording for session ${sessionId}:`, error);
        fs.rm(path.join(sessionDir, 'final-recording.raw.webm.tmp'), { force: true }, () => {});
        fs.rm(path.join(sessionDir, 'final-recording.remuxed.webm.tmp'), { force: true }, () => {});
        writeStitchFailureState(
          sessionDir,
          sessionId,
          chunkFiles,
          'remux_failed',
          error.message,
          trigger
        );
        finishFinalization();
      });
  });
}

module.exports = {
  finalizeSession
};
