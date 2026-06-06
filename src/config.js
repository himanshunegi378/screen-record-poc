const path = require('path');

/**
 * The absolute path to the root directory of the application.
 * @type {string}
 */
const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Application configuration parameters.
 * @namespace
 * @property {number} port - HTTP port used by the Express server.
 * @property {string} publicDir - Absolute path to the directory containing frontend static assets.
 * @property {string} uploadsDir - Absolute path to the directory where recording chunks, events, and final merged videos are saved.
 * @property {string[]} allowedOrigins - Array of browser origins allowed to access the API with credentials.
 * @property {number} sessionQuietTimeoutMs - Duration (in ms) of inactivity before a session is considered 'quiet' by the stitching cron.
 * @property {string} stitchCronSchedule - Cron schedule expression for identifying and stitching quiet sessions.
 */
const config = {
  // HTTP port used by the Express server.
  port: process.env.PORT || 8089,

  // Directory served as the frontend static app.
  publicDir: path.join(ROOT_DIR, 'public'),

  // Directory where recording chunks, events, and final videos are stored.
  uploadsDir: path.join(ROOT_DIR, 'uploads'),

  // Browser origins allowed to call the API with credentials.
  allowedOrigins: [
    'http://localhost:5173',
    'https://admin.tatvauat.samta.ai'
  ],

  // Minimum time since the latest chunk upload before cron considers a session quiet.
  sessionQuietTimeoutMs: 0.5 * 60 * 1000,

  // Cron expression for scanning quiet sessions and rebuilding final recordings.
  stitchCronSchedule: '*/10 * * * * *'
};

module.exports = { config };
