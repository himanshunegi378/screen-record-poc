const { config } = require('./config');
const { createApp } = require('./http/createApp');
const { startStitchCron } = require('./recording/stitchCron');
const { ensureDir } = require('./utils/files');

// Ensure that the uploads directory exists before starting the server.
ensureDir(config.uploadsDir);

/**
 * The Express application instance.
 * @type {Express.Application}
 */
const app = createApp();

// Start the background cron job that regularly checks for and stitches quiet recording sessions.
startStitchCron();

// Start listening for incoming HTTP requests on the configured port.
app.listen(config.port, () => {
  console.log(`==================================================`);
  console.log(`Proctoring POC Backend running on http://localhost:${config.port}`);
  console.log(`Serving frontend from /public`);
  console.log(`Uploads directory path: ${config.uploadsDir}`);
  console.log(`Quiet stitching cron: ${config.stitchCronSchedule}, timeout: ${config.sessionQuietTimeoutMs / 1000}s`);
  console.log(`==================================================`);
});

