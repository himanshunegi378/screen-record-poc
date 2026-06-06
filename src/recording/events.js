const fs = require('fs');
const path = require('path');
const { ensureDir } = require('../utils/files');
const { getSessionDir } = require('../utils/paths');

/**
 * Returns the absolute file path for a session's events log file.
 *
 * @param {string} sessionId - The session ID.
 * @returns {string} The path to events.jsonl for the session.
 */
function getEventFile(sessionId) {
  return path.join(getSessionDir(sessionId), 'events.jsonl');
}

/**
 * Normalizes user/client events from multiple possible client-side schema formats
 * into a single unified format.
 *
 * @param {object} event - The raw event object from client request body.
 * @returns {object} The normalized event object.
 */
function normalizeEvent(event) {
  const sessionId = event.session_id || event.sessionId;
  const type = event.event_type || event.type;
  const timestamp = event.client_time_utc || event.timestamp;
  const metadata = event.payload || event.metadata || {};
  const eventId = event.event_id || null;
  const sequenceNumber = event.sequence_number || null;
  const appVersion = event.app_version || null;

  return {
    sessionId,
    type,
    timestamp,
    metadata,
    event_id: eventId,
    sequence_number: sequenceNumber,
    app_version: appVersion
  };
}

/**
 * Validates and appends a list of events to the session's events log file.
 * Creates the session folder and events file if they do not exist.
 *
 * @param {object[]} eventsList - Array of event objects to append.
 * @returns {object} Object indicating { success: true } or { error: string }.
 */
function appendEvents(eventsList) {
  for (const event of eventsList) {
    const eventData = normalizeEvent(event);

    if (!eventData.sessionId || !eventData.type || !eventData.timestamp) {
      return { error: 'sessionId, type, and timestamp are required' };
    }

    const sessionDir = getSessionDir(eventData.sessionId);
    ensureDir(sessionDir);

    fs.appendFileSync(getEventFile(eventData.sessionId), JSON.stringify(eventData) + '\n', 'utf8');
    console.log(`[EVENT LOGGED] Session: ${eventData.sessionId}, Event: ${eventData.type}`);
  }

  return { success: true };
}

/**
 * Reads and parses all events from the event log file of a given session.
 *
 * @param {string} sessionId - The session ID.
 * @returns {object[]} Array of parsed event objects.
 */
function readEvents(sessionId) {
  const eventFile = getEventFile(sessionId);
  const fileContent = fs.readFileSync(eventFile, 'utf8');
  const lines = fileContent.split('\n').filter(line => line.trim() !== '');
  return lines.map(line => JSON.parse(line));
}

/**
 * Checks if the events log file exists for a given session.
 *
 * @param {string} sessionId - The session ID.
 * @returns {boolean} True if the events log file exists, false otherwise.
 */
function eventFileExists(sessionId) {
  return fs.existsSync(getEventFile(sessionId));
}

module.exports = {
  appendEvents,
  readEvents,
  eventFileExists,
  getEventFile
};

