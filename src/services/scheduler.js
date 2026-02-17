const cron = require('node-cron');
const config = require('../config');
const logger = require('../logger');
const certbot = require('./certbot');
const { refreshServiceCert } = require('./tls');
const { getDb } = require('../db');

// ---------------------------------------------------------------------------
// Day helpers (0 = Sunday … 6 = Saturday)
// ---------------------------------------------------------------------------
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Generate a random renewal schedule: two days per week, 3 days apart,
 * with independent random hour (0-5 → early-morning) and minute.
 */
function generateRandomSchedule() {
  const day1 = Math.floor(Math.random() * 7);          // 0-6
  const day2 = (day1 + 3) % 7;                          // +3 wraps
  const hour1 = Math.floor(Math.random() * 6);          // 0-5
  const min1 = Math.floor(Math.random() * 60);          // 0-59
  const hour2 = Math.floor(Math.random() * 6);
  const min2 = Math.floor(Math.random() * 60);

  return { day1, hour1, min1, day2, hour2, min2 };
}

/**
 * Convert a schedule object to a pair of cron sub-expressions joined by |
 * so we can feed it to node-cron (which does NOT support multi-schedule in
 * one expression). We'll use two separate tasks internally.
 *
 * Actually — node-cron supports comma-separated days but not independent
 * times per day. We need two separate cron entries.
 */
function scheduleToCrons(sched) {
  const c1 = `${sched.min1} ${sched.hour1} * * ${sched.day1}`;
  const c2 = `${sched.min2} ${sched.hour2} * * ${sched.day2}`;
  return [c1, c2];
}

/**
 * Pretty-print a schedule for logging / UI.
 */
function scheduleToString(sched) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${DAY_NAMES[sched.day1]} ${pad(sched.hour1)}:${pad(sched.min1)}, ` +
         `${DAY_NAMES[sched.day2]} ${pad(sched.hour2)}:${pad(sched.min2)}`;
}

// ---------------------------------------------------------------------------
// DB persistence
// ---------------------------------------------------------------------------

const SCHED_KEY = 'renewal_schedule';

function loadScheduleFromDb() {
  const db = getDb();
  const row = db.get('SELECT value FROM settings WHERE key = ?', [SCHED_KEY]);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function saveScheduleToDb(sched) {
  const db = getDb();
  db.upsertSetting(SCHED_KEY, JSON.stringify(sched));
}

// ---------------------------------------------------------------------------
// Resolve the effective schedule
// ---------------------------------------------------------------------------

/**
 * Resolve which schedule to use:
 *   1. RENEWAL_CRON env var → use as-is (single cron expression, legacy)
 *   2. DB-stored schedule → use it
 *   3. Generate random schedule → persist and use
 */
function resolveSchedule() {
  // Env override — single cron string (legacy / power users)
  if (config.renewalCronFromEnv) {
    return { type: 'env', crons: [config.renewalCron], display: `env: ${config.renewalCron}` };
  }

  // DB schedule
  let sched = loadScheduleFromDb();
  if (!sched) {
    sched = generateRandomSchedule();
    saveScheduleToDb(sched);
    logger.info('Generated random renewal schedule', { schedule: scheduleToString(sched) });
  }

  const crons = scheduleToCrons(sched);
  return { type: 'db', schedule: sched, crons, display: scheduleToString(sched) };
}

// ---------------------------------------------------------------------------
// Renewal callback (shared by both cron tasks)
// ---------------------------------------------------------------------------

async function renewalCallback() {
  logger.info('Scheduled renewal check started');
  try {
    const result = await certbot.renewAll();
    if (result.success) {
      if (result.renewed) {
        await certbot.syncCertificates();
        refreshServiceCert();
        logger.info('Scheduled renewal check complete — certificates renewed');
      } else {
        logger.info('Scheduled renewal check complete — nothing to renew');
      }
    } else {
      logger.error('Scheduled renewal check failed', { message: result.message });
    }
  } catch (err) {
    logger.error('Scheduled renewal check error', { err });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let tasks = [];

function start() {
  if (tasks.length > 0) return;

  const resolved = resolveSchedule();

  logger.info('Starting renewal scheduler', { schedule: resolved.display });

  for (const expr of resolved.crons) {
    const t = cron.schedule(expr, renewalCallback);
    tasks.push(t);
  }
}

function stop() {
  for (const t of tasks) t.stop();
  tasks = [];
  logger.info('Renewal scheduler stopped');
}

/**
 * Restart the scheduler with a new DB-persisted schedule.
 * Called from the settings API when the user changes the schedule.
 */
function restart() {
  stop();
  start();
}

/**
 * Get the currently active schedule info (for the settings API).
 */
function getScheduleInfo() {
  const resolved = resolveSchedule();
  return {
    fromEnv: resolved.type === 'env',
    envCron: config.renewalCronFromEnv ? config.renewalCron : null,
    schedule: resolved.schedule || null,
    display: resolved.display,
  };
}

/**
 * Update the schedule in the DB and restart the cron tasks.
 */
function updateSchedule(sched) {
  saveScheduleToDb(sched);
  restart();
  logger.info('Renewal schedule updated', { schedule: scheduleToString(sched) });
}

module.exports = { start, stop, restart, getScheduleInfo, updateSchedule, DAY_NAMES };
