const express = require('express');
const cors = require('cors');
const { config } = require('../config');
const { recordingChunksRouter } = require('./routes/recordingChunks');
const { proctoringEventsRouter } = require('./routes/proctoringEvents');
const { recordingsRouter } = require('./routes/recordings');
const { pagesRouter } = require('./routes/pages');

/**
 * Creates and configures the Express application.
 * Sets up JSON body parsing, CORS, static file serving (for public app and uploads),
 * and registers all API/page router modules.
 *
 * @returns {Express.Application} The configured Express application instance.
 */
function createApp() {
  const app = express();

  // Parse incoming requests with JSON payloads.
  app.use(express.json());

  // Setup CORS middleware based on configuration.
  app.use(cors({
    origin(origin, callback) {
      callback(null, config.allowedOrigins.includes(origin) ? origin : false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 200
  }));

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
