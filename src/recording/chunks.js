const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { parseFiniteNumber } = require('../utils/numbers');
const { getSessionDir, sanitizeSessionId } = require('../utils/paths');


/**
 * Regular expression to match chunk filenames (e.g. chunk-000001.webm).
 * Captures the chunk index.
 * @type {RegExp}
 */
const CHUNK_PATTERN = /^chunk-(\d+)\.webm$/;

/**
 * Sorting function for ordering chunk metadata objects.
 * Orders primarily by startTime, then by endTime, and finally by index.
 *
 * @param {object} a - First chunk metadata object.
 * @param {object} b - Second chunk metadata object.
 * @returns {number} Negative if a comes before b, positive if after, 0 if equal.
 */
function sortChunks(a, b) {
  const aHasTime = a.startTime !== null;
  const bHasTime = b.startTime !== null;

  if (aHasTime && bHasTime && a.startTime !== b.startTime) {
    return a.startTime - b.startTime;
  }
  if (aHasTime !== bHasTime) {
    return aHasTime ? -1 : 1;
  }
  if (a.endTime !== null && b.endTime !== null && a.endTime !== b.endTime) {
    return a.endTime - b.endTime;
  }
  return a.index - b.index;
}

/**
 * Reads the chunks_meta.jsonl file for a session and parses each metadata line.
 *
 * @param {string} sessionDir - The directory of the session.
 * @returns {Map<string, object>} Map of filename to its metadata object.
 */
function readChunkMetadata(sessionDir) {
  const metaFile = path.join(sessionDir, 'chunks_meta.jsonl');
  const metadataByFilename = new Map();

  if (!fs.existsSync(metaFile)) {
    return metadataByFilename;
  }

  const lines = fs.readFileSync(metaFile, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '');

  for (const line of lines) {
    try {
      const metadata = JSON.parse(line);
      if (metadata.filename) {
        metadataByFilename.set(metadata.filename, metadata);
      }
    } catch (error) {
      console.warn(`[CHUNK META WARNING] Skipping malformed metadata line in ${metaFile}:`, error.message);
    }
  }

  return metadataByFilename;
}

/**
 * Returns a sorted array of chunks currently present on disk for a session.
 * Automatically aligns the chunk files with any corresponding metadata records.
 *
 * @param {string} sessionDir - The directory of the session.
 * @returns {object[]} Sorted array of chunk info objects.
 */
function getOrderedChunks(sessionDir) {
  const metadataByFilename = readChunkMetadata(sessionDir);

  return fs.readdirSync(sessionDir)
    .filter(file => CHUNK_PATTERN.test(file))
    .map(file => {
      const match = file.match(CHUNK_PATTERN);
      const metadata = metadataByFilename.get(file) || {};

      return {
        filename: file,
        index: parseInt(match[1], 10),
        startTime: parseFiniteNumber(metadata.startTime),
        endTime: parseFiniteNumber(metadata.endTime),
        absoluteStartTime: parseFiniteNumber(metadata.absoluteStartTime),
        uploadedAt: metadata.uploadedAt || null
      };
    })
    .sort(sortChunks);
}

/**
 * Directly parses and returns chunks metadata from the metadata journal file.
 *
 * @param {string} sessionDir - The session directory.
 * @returns {object[]} Sorted metadata array.
 */
function getOrderedChunksMetadata(sessionDir) {
  const metaFile = path.join(sessionDir, 'chunks_meta.jsonl');
  if (!fs.existsSync(metaFile)) {
    return [];
  }

  const lines = fs.readFileSync(metaFile, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '');

  const chunks = [];
  for (const line of lines) {
    try {
      const metadata = JSON.parse(line);
      chunks.push({
        filename: metadata.filename,
        index: parseInt(metadata.chunkIndex, 10),
        startTime: parseFiniteNumber(metadata.startTime),
        endTime: parseFiniteNumber(metadata.endTime),
        absoluteStartTime: parseFiniteNumber(metadata.absoluteStartTime),
        uploadedAt: metadata.uploadedAt || null
      });
    } catch (error) {
      console.warn(`[CHUNK META WARNING] Skipping malformed metadata line:`, error.message);
    }
  }

  return chunks.sort(sortChunks);
}

/**
 * Helper to determine if a session directory has any recording chunk files.
 *
 * @param {string} sessionDir - The session directory.
 * @returns {boolean} True if chunks are present, false otherwise.
 */
function hasChunks(sessionDir) {
  return fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).some(file => CHUNK_PATTERN.test(file));
}

/**
 * Scans chunks to discover the latest timestamp when a chunk was uploaded.
 * Uses metadata timestamp or falls back to filesystem mtime.
 *
 * @param {string} sessionDir - The directory of the session.
 * @param {object[]} chunkFiles - Array of chunk metadata/file references.
 * @returns {number} Unix epoch timestamp in milliseconds of the latest upload.
 */
function getLatestChunkUploadedAt(sessionDir, chunkFiles) {
  let latestUploadedAt = 0;

  for (const chunk of chunkFiles) {
    const metadataTime = chunk.uploadedAt ? Date.parse(chunk.uploadedAt) : NaN;
    if (Number.isFinite(metadataTime)) {
      latestUploadedAt = Math.max(latestUploadedAt, metadataTime);
      continue;
    }

    const filePath = path.join(sessionDir, chunk.filename);
    if (fs.existsSync(filePath)) {
      latestUploadedAt = Math.max(latestUploadedAt, fs.statSync(filePath).mtimeMs);
    }
  }

  return latestUploadedAt;
}

/**
 * Scans all sessions to find ones that have not received new chunk uploads
 * for longer than the configured sessionQuietTimeoutMs threshold.
 *
 * @returns {string[]} Array of session IDs that are quiet.
 */
function getQuietSessions() {
  if (!fs.existsSync(config.uploadsDir)) {
    return [];
  }

  const now = Date.now();
  const quietSessions = [];

  for (const sessionId of fs.readdirSync(config.uploadsDir)) {
    const actualPath = path.join(config.uploadsDir, sessionId);
    try {
      if (!fs.statSync(actualPath).isDirectory()) {
        continue;
      }
    } catch (err) {
      continue;
    }

    const safeSessionId = sanitizeSessionId(sessionId);
    const sessionDir = getSessionDir(safeSessionId);

    const chunkFiles = getOrderedChunks(sessionDir);
    if (chunkFiles.length === 0) {
      continue;
    }

    // Check if we have already stitched this exact list of chunks
    const stateFile = path.join(sessionDir, 'stitch_state.json');
    if (fs.existsSync(stateFile)) {
      try {
        const stateData = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (Array.isArray(stateData.stitchedChunks)) {
          const currentChunkNames = chunkFiles.map(c => c.filename);
          const isUpToDate = currentChunkNames.length === stateData.stitchedChunks.length &&
            currentChunkNames.every((name, index) => name === stateData.stitchedChunks[index]);
          
          if (isUpToDate) {
            continue;
          }
        }
      } catch (err) {
        console.warn(`[STITCH STATE WARNING] Failed to parse stitch_state.json for session ${safeSessionId}:`, err.message);
      }
    }

    const latestUploadedAt = getLatestChunkUploadedAt(sessionDir, chunkFiles);
    if (latestUploadedAt > 0 && now - latestUploadedAt >= config.sessionQuietTimeoutMs) {
      quietSessions.push(safeSessionId);
    }
  }

  return quietSessions;
}

module.exports = {
  getOrderedChunks,
  getOrderedChunksMetadata,
  hasChunks,
  getLatestChunkUploadedAt,
  getQuietSessions
};

