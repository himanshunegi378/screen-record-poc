const express = require('express');
const { config } = require('../config');
const { recordingChunksRouter } = require('./routes/recordingChunks');
const { proctoringEventsRouter } = require('./routes/proctoringEvents');
const { recordingsRouter } = require('./routes/recordings');
const { pagesRouter } = require('./routes/pages');

/**
 * Creates and configures the Express application.
 * Sets up JSON body parsing, custom CORS headers, static file serving (for public app and uploads),
 * and registers all API/page router modules.
 *
 * @returns {Express.Application} The configured Express application instance.
 */
function createApp() {
  const app = express();

  // Parse incoming requests with JSON payloads.
  app.use(express.json());

  // Setup custom CORS middleware based on configuration.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (config.allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Serve static client application files.
  app.use(express.static(config.publicDir));
  
  // Serve raw uploaded video files directly.
  app.use('/uploads', express.static(config.uploadsDir));

  // Mount API and page route handlers.
  app.use(recordingChunksRouter);
  app.use(proctoringEventsRouter);
  app.use(recordingsRouter);
  app.use(pagesRouter);

  return app;
}

module.exports = { createApp };

