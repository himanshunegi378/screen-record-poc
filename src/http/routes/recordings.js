const express = require('express');
const fs = require('fs');
const path = require('path');
const { config } = require('../../config');
const { getOrderedChunksMetadata, hasChunks } = require('../../recording/chunks');
const { eventFileExists, getEventFile, readEvents } = require('../../recording/events');
const { getSessionDir, sanitizeSessionId } = require('../../utils/paths');

/**
 * Router managing listing of session recording status and retrieving session timelines.
 * @type {express.Router}
 */
const router = express.Router();

/**
 * GET /api/recordings
 * Scans the uploads directory and returns a sorted list of all active or finalized session recordings,
 * including counts of event logs, creation times, and direct video URL links.
 */
router.get('/api/recordings', (req, res) => {
  try {
    const sessions = [];
    if (fs.existsSync(config.uploadsDir)) {
      const files = fs.readdirSync(config.uploadsDir);
      for (const file of files) {
        const sessionDir = path.join(config.uploadsDir, file);
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

          const sessionHasChunks = hasChunks(sessionDir);

          sessions.push({
            sessionId: file,
            videoUrl: hasFinalRecording
              ? `${req.protocol}://${req.get('host')}/uploads/${file}/final-recording.webm`
              : (sessionHasChunks ? `${req.protocol}://${req.get('host')}/api/session/${file}/video` : null),
            eventCount,
            createdAt,
            hasFinalRecording
          });
        }
      }
    }
    sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.status(200).json(sessions);
  } catch (error) {
    console.error('Error retrieving recordings list:', error);
    res.status(500).json({ error: 'Internal server error retrieving recordings list' });
  }
});

/**
 * GET /api/recordings/:sessionId
 * Retrieves detailed metadata, timeline offsets, and enriched events for a specific session.
 * Automatically aligns timeline events relative to a computed "T-zero" start timestamp.
 */
router.get('/api/recordings/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const safeSessionId = sanitizeSessionId(sessionId);

    const sessionDir = getSessionDir(safeSessionId);
    const videoPath = path.join(sessionDir, 'final-recording.webm');

    const hasFinalRecording = fs.existsSync(videoPath);

    if (!eventFileExists(safeSessionId)) {
      return res.status(404).json({ error: `Events log not found for session ${sessionId}` });
    }

    const rawEvents = readEvents(safeSessionId);

    const chunkFiles = getOrderedChunksMetadata(sessionDir);
    let tZero;
    let startType;

    // Establish time zero: either from metadata of first chunk or timestamp of first initialization event.
    if (chunkFiles.length > 0 && chunkFiles[0].absoluteStartTime) {
      tZero = chunkFiles[0].absoluteStartTime;
      startType = 'chunk_metadata';
    } else if (rawEvents.length > 0) {
      const initEvent = rawEvents.find(e => e.type === 'session_initialized');
      const firstEvent = initEvent || rawEvents[0];
      tZero = Date.parse(firstEvent.timestamp);
      startType = initEvent ? 'session_initialized' : 'first_event';
    } else {
      return res.status(400).json({ error: 'Unable to establish a timeline zero timestamp. No recording chunks or events found.' });
    }

    const timelineStartTimestamp = new Date(tZero).toISOString();

    // Enrich events with precise offset times (in seconds) from T-zero.
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

    const sessionHasChunks = hasChunks(sessionDir);

    res.status(200).json({
      sessionId,
      videoUrl: hasFinalRecording
        ? `${req.protocol}://${req.get('host')}/uploads/${safeSessionId}/final-recording.webm`
        : (sessionHasChunks ? `${req.protocol}://${req.get('host')}/api/session/${safeSessionId}/video` : null),
      timelineStartType: startType,
      timelineStartTimestamp: timelineStartTimestamp,
      events: enrichedEvents
    });

  } catch (error) {
    console.error('Error fetching recording details:', error);
    res.status(500).json({ error: 'Internal server error retrieving recording details' });
  }
});

module.exports = { recordingsRouter: router };

