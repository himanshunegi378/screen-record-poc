const fs = require('fs');
const multer = require('multer');
const { getSessionDir, sanitizeSessionId } = require('../utils/paths');
const { ensureDir } = require('../utils/files');

/**
 * Configure disk storage destination and filename generator for Multer.
 * 
 * NOTE: For req.body.sessionId to be populated during the destination callback,
 * the client MUST append 'sessionId' and 'chunkIndex' to FormData BEFORE appending the 'recording' file blob.
 * 
 * @type {multer.StorageEngine}
 */
const storage = multer.diskStorage({
  /**
   * Determine the directory where uploaded chunks will be saved.
   * Creates the session directory if it does not already exist.
   * 
   * @param {Express.Request} req - The HTTP request object.
   * @param {Express.Multer.File} file - Object representing the uploaded file.
   * @param {Function} cb - Callback to pass the destination path.
   */
  destination: (req, file, cb) => {
    const rawSessionId = req.body.sessionId;
    const sessionId = sanitizeSessionId(rawSessionId);
    const sessionDir = getSessionDir(sessionId);

    if (!fs.existsSync(sessionDir)) {
      ensureDir(sessionDir);
    }
    cb(null, sessionDir);
  },
  /**
   * Determine the filename for the uploaded chunk.
   * Generates a zero-padded filename based on the chunk index (e.g. chunk-000003.webm).
   * 
   * @param {Express.Request} req - The HTTP request object.
   * @param {Express.Multer.File} file - Object representing the uploaded file.
   * @param {Function} cb - Callback to pass the generated filename.
   */
  filename: (req, file, cb) => {
    const chunkIndexStr = req.body.chunkIndex || '0';
    const chunkIndex = parseInt(chunkIndexStr, 10);
    const paddedIndex = String(isNaN(chunkIndex) ? 0 : chunkIndex).padStart(6, '0');
    cb(null, `chunk-${paddedIndex}.webm`);
  }
});

/**
 * Multer middleware configured with custom disk storage for handling video chunk uploads.
 * @type {multer.Multer}
 */
const uploadRecordingChunk = multer({ storage });

module.exports = { uploadRecordingChunk };

