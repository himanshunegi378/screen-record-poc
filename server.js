const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

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
    const { sessionId, chunkIndex } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'recording file chunk is required' });
    }
    
    console.log(`[CHUNK UPLOAD] Session: ${sessionId}, Chunk: ${chunkIndex}, Saved to: ${req.file.path}`);
    
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
    const { sessionId, type, timestamp, metadata } = req.body;
    
    if (!sessionId || !type || !timestamp) {
      return res.status(400).json({ error: 'sessionId, type, and timestamp are required' });
    }
    
    const safeSessionId = sanitizeSessionId(sessionId);
    const sessionDir = path.join(UPLOADS_BASE_DIR, safeSessionId);
    
    // Ensure session directory exists
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    const eventFile = path.join(sessionDir, 'events.jsonl');
    const eventData = {
      sessionId,
      type,
      timestamp,
      metadata: metadata || {}
    };
    
    // Append as a single line with trailing newline
    fs.appendFileSync(eventFile, JSON.stringify(eventData) + '\n', 'utf8');
    
    console.log(`[EVENT LOGGED] Session: ${sessionId}, Event: ${type}`);
    
    // Trigger video finalization asynchronously on 'session_completed' event
    if (type === 'session_completed') {
      finalizeSession(safeSessionId);
    }
    
    res.status(200).json({ success: true, message: 'Event logged successfully' });
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
    
    const files = fs.readdirSync(sessionDir);
    const chunks = files
      .filter(file => file.startsWith('chunk-') && file.endsWith('.webm'))
      .map(file => {
        const filePath = path.join(sessionDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          size: stats.size,
          createdAt: stats.mtime
        };
      })
      .sort((a, b) => a.filename.localeCompare(b.filename)); // Order by chunk sequence
      
    res.status(200).json({ sessionId, chunksCount: chunks.length, chunks });
  } catch (error) {
    console.error('Error fetching chunks list:', error);
    res.status(500).json({ error: 'Internal server error retrieving chunks list' });
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
          if (hasFinalRecording) {
            let eventCount = 0;
            const stats = fs.statSync(videoPath);
            const createdAt = stats.mtime;
            
            if (fs.existsSync(eventsPath)) {
              const fileContent = fs.readFileSync(eventsPath, 'utf8');
              eventCount = fileContent.split('\n').filter(line => line.trim() !== '').length;
            }
            
            sessions.push({
              sessionId: file,
              videoUrl: `/uploads/${file}/final-recording.webm`,
              eventCount,
              createdAt,
              hasFinalRecording
            });
          }
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

    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: `Final recording not found for session ${sessionId}` });
    }

    if (!fs.existsSync(eventsPath)) {
      return res.status(404).json({ error: `Events log not found for session ${sessionId}` });
    }

    // Read and parse events.jsonl
    const fileContent = fs.readFileSync(eventsPath, 'utf8');
    const lines = fileContent.split('\n').filter(line => line.trim() !== '');
    const rawEvents = lines.map(line => JSON.parse(line));

    // 1. Locate timeline start timestamp
    // Priority: recording_started -> screen_share_started -> first event
    let timelineStartEvent = rawEvents.find(e => e.type === 'recording_started');
    if (!timelineStartEvent) {
      timelineStartEvent = rawEvents.find(e => e.type === 'screen_share_started');
    }
    if (!timelineStartEvent && rawEvents.length > 0) {
      timelineStartEvent = rawEvents[0];
    }

    if (!timelineStartEvent) {
      return res.status(400).json({ error: 'Unable to establish a timeline zero timestamp. No events recorded.' });
    }

    const tZero = Date.parse(timelineStartEvent.timestamp);
    const startType = timelineStartEvent.type;

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

    res.status(200).json({
      sessionId,
      videoUrl: `/uploads/${safeSessionId}/final-recording.webm`,
      timelineStartType: startType,
      timelineStartTimestamp: timelineStartEvent.timestamp,
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
function finalizeSession(sessionId) {
  const sessionDir = path.join(UPLOADS_BASE_DIR, sessionId);
  console.log(`[FINALIZATION START] Beginning consolidation for session: ${sessionId}`);

  // 1. Read files in the session folder
  fs.readdir(sessionDir, (err, files) => {
    if (err) {
      console.error(`[FINALIZATION ERROR] Failed to read directory for session ${sessionId}:`, err);
      return;
    }

    // 2. Filter and parse indices of chunks
    const chunkPattern = /^chunk-(\d+)\.webm$/;
    const chunkFiles = files
      .filter(file => chunkPattern.test(file))
      .map(file => {
        const match = file.match(chunkPattern);
        return {
          filename: file,
          index: parseInt(match[1], 10)
        };
      })
      // Sort numerically in ascending order
      .sort((a, b) => a.index - b.index);

    if (chunkFiles.length === 0) {
      console.log(`[FINALIZATION SKIPPED] No chunks found to consolidate for session: ${sessionId}`);
      return;
    }

    // 3. Create input list file content for FFmpeg concat demuxer
    // We use relative filenames inside the list since we will set the cwd to sessionDir when executing FFmpeg.
    const listContent = chunkFiles
      .map(chunk => `file '${chunk.filename}'`)
      .join('\n');

    const listFilePath = path.join(sessionDir, 'ffmpeg_inputs.txt');
    
    fs.writeFile(listFilePath, listContent, 'utf8', (writeErr) => {
      if (writeErr) {
        console.error(`[FINALIZATION ERROR] Failed to write inputs list for session ${sessionId}:`, writeErr);
        return;
      }

      // 4. Exec FFmpeg concat demuxer
      const outputFilename = 'final-recording.webm';
      const outputFilePath = path.join(sessionDir, outputFilename);
      
      // -y overwrites existing file
      // -f concat selects the concat demuxer
      // -safe 0 allows absolute or non-standard relative paths
      // -c copy copies the video/audio streams directly without re-encoding (instant and lossless)
      const command = `ffmpeg -y -f concat -safe 0 -i ffmpeg_inputs.txt -c copy "${outputFilename}"`;

      exec(command, { cwd: sessionDir }, (execErr, stdout, stderr) => {
        // Always clean up the temporary inputs list file
        fs.unlink(listFilePath, (unlinkErr) => {
          if (unlinkErr) {
            console.warn(`[FINALIZATION WARNING] Failed to delete temp list file for session ${sessionId}:`, unlinkErr);
          }
        });

        if (execErr) {
          console.error(`[FINALIZATION ERROR] FFmpeg execution failed for session ${sessionId}:`, execErr);
          console.error(`FFmpeg stderr output:`, stderr);
          return;
        }

        console.log(`[FINALIZATION SUCCESS] Consolidated video saved for session: ${sessionId}`);
        
        // 5. Append final_recording_created event to events.jsonl
        const eventFile = path.join(sessionDir, 'events.jsonl');
        const finalEvent = {
          sessionId: sessionId,
          type: 'final_recording_created',
          timestamp: new Date().toISOString(),
          metadata: {
            outputFile: outputFilename,
            chunksCount: chunkFiles.length,
            totalSize: fs.existsSync(outputFilePath) ? fs.statSync(outputFilePath).size : 0
          }
        };

        fs.appendFile(eventFile, JSON.stringify(finalEvent) + '\n', 'utf8', (appendErr) => {
          if (appendErr) {
            console.error(`[FINALIZATION ERROR] Failed to log final_recording_created event for session ${sessionId}:`, appendErr);
          } else {
            console.log(`[FINALIZATION EVENT] Appended final_recording_created event for session: ${sessionId}`);
          }
        });
      });
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
