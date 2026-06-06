const path = require('path');
const { config } = require('../config');

/**
 * Sanitizes a session ID string by stripping any characters that are not alphanumeric,
 * underscores, or hyphens. Helps prevent directory traversal attacks.
 *
 * @param {string} sessionId - The raw session ID.
 * @returns {string} The sanitized session ID or 'default_session' if invalid.
 */
function sanitizeSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    return 'default_session';
  }
  return sessionId.replace(/[^a-zA-Z0-9\-_]/g, '');
}

/**
 * Resolves the absolute directory path where recording data for a specific session is stored.
 *
 * @param {string} sessionId - The session ID.
 * @returns {string} The absolute directory path of the session uploads.
 */
function getSessionDir(sessionId) {
  return path.join(config.uploadsDir, sanitizeSessionId(sessionId));
}

module.exports = {
  sanitizeSessionId,
  getSessionDir
};

