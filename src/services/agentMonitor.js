const cron = require('node-cron');
const { getDb, toSqliteDatetime } = require('../db');
const logger = require('../logger');

let monitorTask = null;

// ---------------------------------------------------------------------------
// Helper: read agent monitoring settings from DB
// ---------------------------------------------------------------------------
function getAgentSettings() {
  const db = getDb();
  const intervalRow = db.get("SELECT value FROM settings WHERE key = 'agent_heartbeat_interval'");
  const thresholdRow = db.get("SELECT value FROM settings WHERE key = 'agent_offline_threshold'");

  const intervalSeconds = parseInt(intervalRow?.value, 10) || 180;       // default 3 min
  const missedThreshold = parseInt(thresholdRow?.value, 10) || 3;        // default 3 missed

  return { intervalSeconds, missedThreshold };
}

// ---------------------------------------------------------------------------
// Check for agents that have gone offline
//
// An agent is considered offline when:
//   next_contact_at + (interval × threshold) < now
//
// We only transition agents whose status is NOT already 'offline' to avoid
// duplicate alerts.
// ---------------------------------------------------------------------------
function checkOfflineAgents() {
  const db = getDb();
  const { intervalSeconds, missedThreshold } = getAgentSettings();
  const graceSeconds = intervalSeconds * missedThreshold;
  const cutoff = toSqliteDatetime(new Date(Date.now() - graceSeconds * 1000));

  // Find enrolled agents that are overdue and not already offline
  const overdueAgents = db.all(
    `SELECT id, name, status, next_contact_at, last_contact_at
     FROM agents
     WHERE enabled = 1
       AND cert_fingerprint IS NOT NULL
       AND next_contact_at IS NOT NULL
       AND next_contact_at < ?
       AND (status IS NULL OR status != 'offline')`,
    [cutoff],
  );

  for (const agent of overdueAgents) {
    db.run(
      "UPDATE agents SET status = 'offline', updated_at = datetime('now') WHERE id = ?",
      [agent.id],
    );

    logger.info('Agent went offline', {
      id: agent.id,
      name: agent.name,
      lastContact: agent.last_contact_at,
      nextExpected: agent.next_contact_at,
    });

    db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
      'agent_offline',
      JSON.stringify({ id: agent.id, name: agent.name, lastContact: agent.last_contact_at }),
    ]);

    // TODO: trigger agent_offline notification via notification service
  }
}

// ---------------------------------------------------------------------------
// Start the monitor cron (runs every minute)
// ---------------------------------------------------------------------------
function start() {
  if (monitorTask) return;

  monitorTask = cron.schedule('* * * * *', () => {
    try {
      checkOfflineAgents();
    } catch (err) {
      logger.error('Agent monitor check failed', { error: err.message });
    }
  });

  logger.info('Agent monitor started (checking every 1 minute)');
}

function stop() {
  if (monitorTask) {
    monitorTask.stop();
    monitorTask = null;
  }
}

module.exports = { start, stop, checkOfflineAgents, getAgentSettings };
