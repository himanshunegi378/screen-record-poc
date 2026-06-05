const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8000;
const FINALIZATION_DEBOUNCE_MS = 1000;
const DELETE_CHUNKS_AFTER_ROLLING_MERGE = true;
const finalizationTimers = new Map();
const finalizationInProgress = new Set();
const finalizationRerunRequested = new Set();

// Middleware to parse JSON bodies
app.use(express.json());

// Enable CORS for http://localhost:5173
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve static uploads directory for final-recordings playback
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Create uploads base directory if it doesn't exist
const UPLOADS_BASE_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_BASE_DIR)) {
  fs.mkdirSync(UPLOADS_BASE_DIR, { recursive: true });
}

/**
 * Helper to sanitize sessionId to prevent path traversal vulnerability.
 * Only allows alphanumeric characters, hyphens, and underscores.
 */
function sanitizeSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    return 'default_session';
  }
  return sessionId.replace(/[^a-zA-Z0-9\-_]/g, '');
}

function parseFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

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

function getOrderedChunks(sessionDir) {
  const chunkPattern = /^chunk-(\d+)\.webm$/;
  const metadataByFilename = readChunkMetadata(sessionDir);

  return fs.readdirSync(sessionDir)
    .filter(file => chunkPattern.test(file))
    .map(file => {
      const match = file.match(chunkPattern);
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
    .sort((a, b) => {
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
    });
}

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

  return chunks.sort((a, b) => {
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
  });
}

function appendFileToStream(sourceFilePath, outputStream) {
  return new Promise((resolve, reject) => {
    const inputStream = fs.createReadStream(sourceFilePath);

    inputStream.on('error', reject);
    inputStream.on('end', resolve);
    inputStream.pipe(outputStream, { end: false });
  });
}

function writeRollingFinalRecording(sessionDir, chunkFiles) {
  const outputFilename = 'final-recording.webm';
  const tempFilename = `${outputFilename}.tmp`;
  const outputFilePath = path.join(sessionDir, outputFilename);
  const tempFilePath = path.join(sessionDir, tempFilename);

  return new Promise(async (resolve, reject) => {
    const outputStream = fs.createWriteStream(tempFilePath);

    outputStream.on('error', reject);

    try {
      if (fs.existsSync(outputFilePath)) {
        await appendFileToStream(outputFilePath, outputStream);
      }

      for (const chunk of chunkFiles) {
        await appendFileToStream(path.join(sessionDir, chunk.filename), outputStream);
      }

      outputStream.end();
      outputStream.on('finish', () => {
        fs.rename(tempFilePath, outputFilePath, (renameErr) => {
          if (renameErr) {
            reject(renameErr);
            return;
          }

          resolve(outputFilePath);
        });
      });
    } catch (error) {
      outputStream.destroy();
      fs.rm(tempFilePath, { force: true }, () => reject(error));
    }
  });
}

function cleanupChunkFiles(sessionDir, chunkFiles) {
  for (const chunk of chunkFiles) {
    fs.rm(path.join(sessionDir, chunk.filename), { force: true }, (error) => {
      if (error) {
        console.warn(`[CHUNK CLEANUP WARNING] Failed to delete ${chunk.filename}:`, error);
      }
    });
  }
}

function remuxWebmDuration(sessionDir, inputFilePath) {
  const remuxedFilePath = path.join(sessionDir, 'final-recording.remuxed.webm');

  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-y', '-fflags', '+genpts', '-i', inputFilePath, '-c', 'copy', remuxedFilePath],
      { cwd: sessionDir },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }

        fs.rename(remuxedFilePath, inputFilePath, (renameErr) => {
          if (renameErr) {
            reject(renameErr);
            return;
          }

          resolve(inputFilePath);
        });
      }
    );
  });
}

// Multer Storage configuration
// NOTE: For req.body.sessionId to be populated during the destination callback,
// the client MUST append 'sessionId' and 'chunkIndex' to FormData BEFORE appending the 'recording' file blob.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const rawSessionId = req.body.sessionId;
    const sessionId = sanitizeSessionId(rawSessionId);
    const sessionDir = path.join(UPLOADS_BASE_DIR, sessionId);

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    cb(null, sessionDir);
  },
  filename: (req, file, cb) => {
    const chunkIndexStr = req.body.chunkIndex || '0';
    const chunkIndex = parseInt(chunkIndexStr, 10);
    const paddedIndex = String(isNaN(chunkIndex) ? 0 : chunkIndex).padStart(6, '0');
    cb(null, `chunk-${paddedIndex}.webm`);
  }
});

const upload = multer({ storage });

/**
 * Endpoint: POST /api/recording/chunk
 * Accepts multipart/form-data for chunked screen recording uploads.
 * Fields: sessionId, chunkIndex, recording
 */
app.post('/api/recording/chunk', upload.single('recording'), (req, res) => {
  try {
    const { sessionId, chunkIndex, startTime, endTime, absoluteStartTime } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'recording file chunk is required' });
    }

    console.log(`[CHUNK UPLOAD] Session: ${sessionId}, Chunk: ${chunkIndex}, Saved to: ${req.file.path}`);

    const safeSessionId = sanitizeSessionId(sessionId);
    const sessionDir = path.join(UPLOADS_BASE_DIR, safeSessionId);

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const metaFile = path.join(sessionDir, 'chunks_meta.jsonl');
    const metaData = {
      chunkIndex: parseInt(chunkIndex, 10),
      filename: req.file.filename,
      startTime: startTime ? parseFloat(startTime) : null,
      endTime: endTime ? parseFloat(endTime) : null,
      absoluteStartTime: absoluteStartTime ? parseFloat(absoluteStartTime) : null,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };

    fs.appendFileSync(metaFile, JSON.stringify(metaData) + '\n', 'utf8');
    scheduleFinalizeSession(safeSessionId);

    res.status(200).json({
      success: true,
      message: 'Chunk uploaded successfully',
      path: req.file.path,
      chunkIndex: chunkIndex
    });
  } catch (error) {
    console.error('Error handling chunk upload:', error);
    res.status(500).json({ error: 'Internal server error during chunk upload' });
  }
});

/**
 * Endpoint: POST /api/proctoring/event
 * Appends proctoring events to uploads/<sessionId>/events.jsonl.
 */
app.post('/api/proctoring/event', (req, res) => {
  try {
    const body = req.body;
    const eventsList = Array.isArray(body) ? body : [body];

    if (eventsList.length === 0) {
      return res.status(400).json({ error: 'No events provided' });
    }

    for (const event of eventsList) {
      const sessionId = event.session_id || event.sessionId;
      const type = event.event_type || event.type;
      const timestamp = event.client_time_utc || event.timestamp;
      const metadata = event.payload || event.metadata || {};
      const eventId = event.event_id || null;
      const sequenceNumber = event.sequence_number || null;
      const appVersion = event.app_version || null;

      if (!sessionId || !type || !timestamp) {
        return res.status(400).json({ error: 'sessionId, type, and timestamp are required' });
      }

      const safeSessionId = sanitizeSessionId(sessionId);
      const sessionDir = path.join(UPLOADS_BASE_DIR, safeSessionId);

      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      const eventFile = path.join(sessionDir, 'events.jsonl');
      const eventData = {
        sessionId,
        type,
        timestamp,
        metadata,
        event_id: eventId,
        sequence_number: sequenceNumber,
        app_version: appVersion
      };

      fs.appendFileSync(eventFile, JSON.stringify(eventData) + '\n', 'utf8');
      console.log(`[EVENT LOGGED] Session: ${sessionId}, Event: ${type}`);
    }

    res.status(200).json({ success: true, message: 'Events logged successfully' });
  } catch (error) {
    console.error('Error writing proctoring event:', error);
    res.status(500).json({ error: 'Internal server error writing event' });
  }
});

/**
 * Endpoint: GET /api/session/:sessionId/events
 * Retrieves events for a specific session by reading the events.jsonl file.
 */
app.get('/api/session/:sessionId/events', (req, res) => {
  try {
    const { sessionId } = req.params;
    const safeSessionId = sanitizeSessionId(sessionId);
    const eventFile = path.join(UPLOADS_BASE_DIR, safeSessionId, 'events.jsonl');

    if (!fs.existsSync(eventFile)) {
      return res.status(404).json({ error: `No events found for session ${sessionId}` });
    }

    const fileContent = fs.readFileSync(eventFile, 'utf8');
    const lines = fileContent.split('\n').filter(line => line.trim() !== '');
    const events = lines.map(line => JSON.parse(line));

    res.status(200).json({ sessionId, events });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Internal server error retrieving events' });
  }
});

/**
 * Endpoint: GET /api/session/:sessionId/chunks
 * Lists uploaded chunks for a session.
 */
app.get('/api/session/:sessionId/chunks', (req, res) => {
  try {
    const { sessionId } = req.params;
    const safeSessionId = sanitizeSessionId(sessionId);
    const sessionDir = path.join(UPLOADS_BASE_DIR, safeSessionId);

    if (!fs.existsSync(sessionDir)) {
      return res.status(404).json({ error: `Session ${sessionId} directory not found` });
    }

    const chunks = getOrderedChunks(sessionDir)
      .map(chunk => {
        const filePath = path.join(sessionDir, chunk.filename);
        const stats = fs.statSync(filePath);
        return {
          filename: chunk.filename,
          chunkIndex: chunk.index,
          startTime: chunk.startTime,
          endTime: chunk.endTime,
          size: stats.size,
          createdAt: stats.mtime
        };
      });

    res.status(200).json({ sessionId, chunksCount: chunks.length, chunks });
  } catch (error) {
    console.error('Error fetching chunks list:', error);
    res.status(500).json({ error: 'Internal server error retrieving chunks list' });
  }
});

/**
 * Endpoint: GET /api/session/:sessionId/video
 * Dynamically streams all uploaded chunk files sequentially back-to-back as a single video response.
 */
app.get('/api/session/:sessionId/video', (req, res) => {
  try {
    const { sessionId } = req.params;
    const safeSessionId = sanitizeSessionId(sessionId);
    const sessionDir = path.join(UPLOADS_BASE_DIR, safeSessionId);

    if (!fs.existsSync(sessionDir)) {
      return res.status(404).json({ error: `Session ${sessionId} not found` });
    }

    const chunks = getOrderedChunks(sessionDir);

    if (chunks.length === 0) {
      return res.status(404).json({ error: 'No recording chunks found' });
    }

    res.setHeader('Content-Type', 'video/webm');
    res.setHeader('Accept-Ranges', 'none');

    let fileIndex = 0;

    function streamNext() {
      if (fileIndex >= chunks.length) {
        res.end();
        return;
      }

      const filePath = path.join(sessionDir, chunks[fileIndex].filename);
      const readStream = fs.createReadStream(filePath);

      readStream.on('error', (err) => {
        console.error('Error reading chunk file during streaming:', err);
        res.end();
      });

      readStream.on('end', () => {
        fileIndex++;
        streamNext();
      });

      readStream.pipe(res, { end: false });
    }

    streamNext();
  } catch (error) {
    console.error('Error streaming chunked video:', error);
    res.status(500).json({ error: 'Internal server error streaming video' });
  }
});

/**
 * Endpoint: GET /api/recordings
 * Scans the uploads/ directory and lists all sessions containing final-recording.webm.
 */
app.get('/api/recordings', (req, res) => {
  try {
    const sessions = [];
    if (fs.existsSync(UPLOADS_BASE_DIR)) {
      const files = fs.readdirSync(UPLOADS_BASE_DIR);
      for (const file of files) {
        const sessionDir = path.join(UPLOADS_BASE_DIR, file);
        if (fs.statSync(sessionDir).isDirectory()) {
          const videoPath = path.join(sessionDir, 'final-recording.webm');
          const eventsPath = path.join(sessionDir, 'events.jsonl');

          const hasFinalRecording = fs.existsSync(videoPath);
          let eventCount = 0;
          let createdAt = fs.statSync(sessionDir).mtime;

          if (hasFinalRecording) {
            const stats = fs.statSync(videoPath);
            createdAt = stats.mtime;
          }

          if (fs.existsSync(eventsPath)) {
            const fileContent = fs.readFileSync(eventsPath, 'utf8');
            eventCount = fileContent.split('\n').filter(line => line.trim() !== '').length;
            if (!hasFinalRecording) {
              createdAt = fs.statSync(eventsPath).mtime;
            }
          }

          const chunkPattern = /^chunk-(\d+)\.webm$/;
          const hasChunks = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).some(f => chunkPattern.test(f));

          sessions.push({
            sessionId: file,
            videoUrl: hasFinalRecording
              ? `http://localhost:8000/uploads/${file}/final-recording.webm`
              : (hasChunks ? `http://localhost:8000/api/session/${file}/video` : null),
            eventCount,
            createdAt,
            hasFinalRecording
          });
        }
      }
    }
    // Sort sessions in reverse chronological order (newest first)
    sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.status(200).json(sessions);
  } catch (error) {
    console.error('Error retrieving recordings list:', error);
    res.status(500).json({ error: 'Internal server error retrieving recordings list' });
  }
});

/**
 * Endpoint: GET /api/recordings/:sessionId
 * Returns the timeline of events with offsetSeconds mapped from the start of the recording.
 */
app.get('/api/recordings/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const safeSessionId = sanitizeSessionId(sessionId);

    const sessionDir = path.join(UPLOADS_BASE_DIR, safeSessionId);
    const videoPath = path.join(sessionDir, 'final-recording.webm');
    const eventsPath = path.join(sessionDir, 'events.jsonl');

    const hasFinalRecording = fs.existsSync(videoPath);

    if (!fs.existsSync(eventsPath)) {
      return res.status(404).json({ error: `Events log not found for session ${sessionId}` });
    }

    // Read and parse events.jsonl
    const fileContent = fs.readFileSync(eventsPath, 'utf8');
    const lines = fileContent.split('\n').filter(line => line.trim() !== '');
    const rawEvents = lines.map(line => JSON.parse(line));

    // 1. Locate timeline start timestamp
    const chunkFiles = getOrderedChunksMetadata(sessionDir);
    if (chunkFiles.length === 0 || !chunkFiles[0].absoluteStartTime) {
      return res.status(400).json({ error: 'Unable to establish a timeline zero timestamp. No recording chunks with absolute start times found.' });
    }

    const tZero = chunkFiles[0].absoluteStartTime;
    const startType = 'chunk_metadata';
    const timelineStartTimestamp = new Date(tZero).toISOString();

    // 2. Map events to include offsetSeconds from tZero
    const enrichedEvents = rawEvents.map(event => {
      const tEvent = Date.parse(event.timestamp);
      const offsetSeconds = (tEvent - tZero) / 1000;
      return {
        type: event.type,
        timestamp: event.timestamp,
        offsetSeconds: parseFloat(offsetSeconds.toFixed(3)),
        metadata: event.metadata || {}
      };
    });

    const chunkPattern = /^chunk-(\d+)\.webm$/;
    const hasChunks = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).some(f => chunkPattern.test(f));

    res.status(200).json({
      sessionId,
      videoUrl: hasFinalRecording
        ? `http://localhost:8000/uploads/${safeSessionId}/final-recording.webm`
        : (hasChunks ? `http://localhost:8000/api/session/${safeSessionId}/video` : null),
      timelineStartType: startType,
      timelineStartTimestamp: timelineStartTimestamp,
      events: enrichedEvents
    });

  } catch (error) {
    console.error('Error fetching recording details:', error);
    res.status(500).json({ error: 'Internal server error retrieving recording details' });
  }
});

/**
 * Asynchronously consolidates all chunk-XXXXXX.webm files for a session
 * into a single final-recording.webm file using FFmpeg.
 */
function scheduleFinalizeSession(sessionId) {
  if (finalizationInProgress.has(sessionId)) {
    finalizationRerunRequested.add(sessionId);
    console.log(`[FINALIZATION QUEUED] Stitch already running; queued another pass for session: ${sessionId}`);
    return;
  }

  if (finalizationTimers.has(sessionId)) {
    clearTimeout(finalizationTimers.get(sessionId));
  }

  console.log(`[FINALIZATION SCHEDULED] Stitching session ${sessionId} in ${FINALIZATION_DEBOUNCE_MS}ms`);
  const timer = setTimeout(() => {
    finalizationTimers.delete(sessionId);
    finalizeSession(sessionId);
  }, FINALIZATION_DEBOUNCE_MS);

  finalizationTimers.set(sessionId, timer);
}

function finalizeSession(sessionId) {
  const sessionDir = path.join(UPLOADS_BASE_DIR, sessionId);
  console.log(`[FINALIZATION START] Beginning consolidation for session: ${sessionId}`);
  finalizationInProgress.add(sessionId);

  function finishFinalization() {
    finalizationInProgress.delete(sessionId);

    if (finalizationRerunRequested.has(sessionId)) {
      finalizationRerunRequested.delete(sessionId);
      scheduleFinalizeSession(sessionId);
    }
  }

  // 1. Read files in the session folder
  fs.readdir(sessionDir, (err, files) => {
    if (err) {
      console.error(`[FINALIZATION ERROR] Failed to read directory for session ${sessionId}:`, err);
      finishFinalization();
      return;
    }

    // 2. Order chunks by recorded capture time, with filename index as a fallback.
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

    // 3. Append pending chunks to the rolling final recording.
    // MediaRecorder often emits WebM fragments where only the first file has a full EBML header,
    // so raw append is more reliable here than FFmpeg's concat demuxer for this upload shape.
    const outputFilePath = path.join(sessionDir, 'final-recording.webm');
    const hadFinalRecording = fs.existsSync(outputFilePath);

    writeRollingFinalRecording(sessionDir, chunkFiles)
      .then((finalRecordingPath) => remuxWebmDuration(sessionDir, finalRecordingPath))
      .then((finalRecordingPath) => {
        console.log(`[FINALIZATION SUCCESS] Rolling video saved for session: ${sessionId}`);

        const eventFile = path.join(sessionDir, 'events.jsonl');
        const finalEvent = {
          sessionId: sessionId,
          type: hadFinalRecording ? 'final_recording_updated' : 'final_recording_created',
          timestamp: new Date().toISOString(),
          metadata: {
            outputFile: 'final-recording.webm',
            mergedChunksCount: chunkFiles.length,
            totalSize: fs.existsSync(finalRecordingPath) ? fs.statSync(finalRecordingPath).size : 0,
            rolling: true,
            deletedMergedChunks: DELETE_CHUNKS_AFTER_ROLLING_MERGE
          }
        };

        fs.appendFile(eventFile, JSON.stringify(finalEvent) + '\n', 'utf8', (appendErr) => {
          if (appendErr) {
            console.error(`[FINALIZATION ERROR] Failed to log ${finalEvent.type} event for session ${sessionId}:`, appendErr);
          } else {
            console.log(`[FINALIZATION EVENT] Appended ${finalEvent.type} event for session: ${sessionId}`);
          }

          if (DELETE_CHUNKS_AFTER_ROLLING_MERGE) {
            cleanupChunkFiles(sessionDir, chunkFiles);
          }

          finishFinalization();
        });
      })
      .catch((error) => {
        console.error(`[FINALIZATION ERROR] Failed to rebuild rolling final recording for session ${sessionId}:`, error);
        finishFinalization();
      });
  });
}

// Catch-all route to serve the single page app index.html for pushState routing
app.get(['/sandbox', '/recordings', '/recordings/:sessionId'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`Proctoring POC Backend running on http://localhost:${PORT}`);
  console.log(`Serving frontend from /public`);
  console.log(`Uploads directory path: ${UPLOADS_BASE_DIR}`);
  console.log(`==================================================`);
});
