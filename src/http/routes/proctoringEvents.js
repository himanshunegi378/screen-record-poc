const express = require('express');
const { appendEvents, eventFileExists, readEvents } = require('../../recording/events');

/**
 * Router managing proctoring event submissions and event retrieval.
 * @type {express.Router}
 */
const router = express.Router();

/**
 * POST /api/proctoring/event
 * Receives one or more user/client events and appends them to the session's event log file.
 */
router.post('/api/proctoring/event', (req, res) => {
  try {
    const body = req.body;
    const eventsList = Array.isArray(body) ? body : [body];

    if (eventsList.length === 0) {
      return res.status(400).json({ error: 'No events provided' });
    }

    const result = appendEvents(eventsList);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    res.status(200).json({ success: true, message: 'Events logged successfully' });
  } catch (error) {
    console.error('Error writing proctoring event:', error);
    res.status(500).json({ error: 'Internal server error writing event' });
  }
});

/**
 * GET /api/session/:sessionId/events
 * Retrieves all normalized events recorded for a specific session.
 */
router.get('/api/session/:sessionId/events', (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!eventFileExists(sessionId)) {
      return res.status(404).json({ error: `No events found for session ${sessionId}` });
    }

    const events = readEvents(sessionId);

    res.status(200).json({ sessionId, events });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Internal server error retrieving events' });
  }
});

module.exports = { proctoringEventsRouter: router };

