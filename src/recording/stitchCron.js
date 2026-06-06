const cron = require('node-cron');
const { config } = require('../config');
const { getQuietSessions } = require('./chunks');
const { finalizeSession } = require('./finalize');

/**
 * Scans all session directories for quiet sessions (no new chunk uploads within quiet threshold)
 * and triggers a finalization run for each quiet session without deleting the source chunks.
 *
 * @returns {void}
 */
function runQuietSessionStitchJob() {
  const quietSessions = getQuietSessions();

  if (quietSessions.length === 0) {
    return;
  }

  for (const sessionId of quietSessions) {
    console.log(`[STITCH CRON] Rebuilding final recording for quiet session: ${sessionId}`);
    finalizeSession(sessionId, {
      deleteChunks: false,
      trigger: 'quiet_cron'
    });
  }
}

/**
 * Initializes and starts the background node-cron schedule according to config.stitchCronSchedule.
 *
 * @returns {cron.ScheduledTask} The scheduled task instance.
 */
function startStitchCron() {
  return cron.schedule(config.stitchCronSchedule, runQuietSessionStitchJob);
}

module.exports = {
  runQuietSessionStitchJob,
  startStitchCron
};

