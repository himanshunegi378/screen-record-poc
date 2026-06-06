const express = require('express');
const fs = require('fs');
const path = require('path');
const { uploadRecordingChunk } = require('../../storage/uploadMiddleware');
const { getOrderedChunks } = require('../../recording/chunks');
const { ensureDir } = require('../../utils/files');
const { getSessionDir, sanitizeSessionId } = require('../../utils/paths');

/**
 * Router managing recording chunk uploads, chunk listings, and live pseudo-streaming.
 * @type {express.Router}
 */
const router = express.Router();

/**
 * POST /api/recording/chunk
 * Accepts a single WebM recording chunk, writes it to disk, and updates the chunks metadata log.
 */
router.post('/api/recording/chunk', uploadRecordingChunk.single('recording'), (req, res) => {
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
    const sessionDir = getSessionDir(safeSessionId);
    ensureDir(sessionDir);

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
 * GET /api/session/:sessionId/chunks
 * Lists all uploaded chunks for a session, including indexes, file sizes, and timestamps.
 */
router.get('/api/session/:sessionId/chunks', (req, res) => {
  try {
    const { sessionId } = req.params;
    const safeSessionId = sanitizeSessionId(sessionId);
    const sessionDir = getSessionDir(safeSessionId);

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
 * GET /api/session/:sessionId/video
 * Streams the active recording by dynamically concatenating WebM chunks in chronological order.
 * Serves as a live-streaming fallback when a unified file is not yet finalized.
 */
router.get('/api/session/:sessionId/video', (req, res) => {
  try {
    const { sessionId } = req.params;
    const safeSessionId = sanitizeSessionId(sessionId);
    const sessionDir = getSessionDir(safeSessionId);

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

    // Helper function to pipe chunks sequentially to the HTTP response stream.
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

module.exports = { recordingChunksRouter: router };

