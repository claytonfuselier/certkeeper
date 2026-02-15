const express = require('express');
const { getDb } = require('../db');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_EVENTS = ['issued', 'renewed', 'expiry_warning', 'error', 'revoked'];
const DEFAULT_EVENTS = ['issued', 'renewed', 'expiry_warning', 'error'];

function getChannelConfig(channel) {
  const db = getDb();
  const row = db.get('SELECT value FROM settings WHERE key = ?', [`notif_${channel}`]);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function saveChannelConfig(channel, config) {
  const db = getDb();
  const json = JSON.stringify(config);
  const key = `notif_${channel}`;
  const existing = db.get('SELECT key FROM settings WHERE key = ?', [key]);
  if (existing) {
    db.run("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?", [json, key]);
  } else {
    db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, json]);
  }
}

function validateEvents(events) {
  if (!Array.isArray(events)) return DEFAULT_EVENTS;
  return events.filter((e) => VALID_EVENTS.includes(e));
}

function maskSecret(str) {
  if (!str) return '';
  if (str.length <= 6) return '••••••';
  return str.slice(0, 3) + '•'.repeat(Math.min(str.length - 6, 20)) + str.slice(-3);
}

// ---------------------------------------------------------------------------
// GET /api/notifications — retrieve all notification channel configs
// ---------------------------------------------------------------------------
router.get('/', (_req, res) => {
  const email = getChannelConfig('email') || {};
  const webhook = getChannelConfig('webhook') || {};
  const pushover = getChannelConfig('pushover') || {};
  const gotify = getChannelConfig('gotify') || {};
  const slack = getChannelConfig('slack') || {};
  const discord = getChannelConfig('discord') || {};
  const telegram = getChannelConfig('telegram') || {};

  res.json({
    email: {
      enabled: !!email.enabled,
      to: email.to || '',
      events: email.events || DEFAULT_EVENTS,
    },
    webhook: {
      enabled: !!webhook.enabled,
      url: webhook.url || '',
      hasSecret: !!webhook.secret,
      events: webhook.events || DEFAULT_EVENTS,
    },
    pushover: {
      enabled: !!pushover.enabled,
      userKey: pushover.userKey || '',
      hasToken: !!pushover.appToken,
      events: pushover.events || DEFAULT_EVENTS,
    },
    gotify: {
      enabled: !!gotify.enabled,
      url: gotify.url || '',
      hasToken: !!gotify.appToken,
      priority: gotify.priority ?? 5,
      events: gotify.events || DEFAULT_EVENTS,
    },
    slack: {
      enabled: !!slack.enabled,
      webhookUrl: slack.webhookUrl || '',
      channel: slack.channel || '',
      events: slack.events || DEFAULT_EVENTS,
    },
    discord: {
      enabled: !!discord.enabled,
      webhookUrl: discord.webhookUrl || '',
      events: discord.events || DEFAULT_EVENTS,
    },
    telegram: {
      enabled: !!telegram.enabled,
      chatId: telegram.chatId || '',
      hasBotToken: !!telegram.botToken,
      events: telegram.events || DEFAULT_EVENTS,
    },
  });
});

// ---------------------------------------------------------------------------
// PUT /api/notifications/email — save email notification config
// ---------------------------------------------------------------------------
router.put('/email', (req, res) => {
  const { enabled, to, events } = req.body || {};

  if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const config = {
    enabled: !!enabled,
    to: (to || '').trim(),
    events: validateEvents(events),
  };

  saveChannelConfig('email', config);
  logger.info('Email notification settings updated', { enabled: config.enabled });

  const db = getDb();
  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'notif_email_updated', JSON.stringify({ enabled: config.enabled }),
  ]);

  res.json({ ok: true, email: config });
});

// ---------------------------------------------------------------------------
// PUT /api/notifications/webhook — save webhook notification config
// ---------------------------------------------------------------------------
router.put('/webhook', (req, res) => {
  const { enabled, url, secret, events } = req.body || {};

  if (enabled && !url) {
    return res.status(400).json({ error: 'Webhook URL is required when enabled' });
  }

  if (url && !/^https?:\/\/.+/.test(url)) {
    return res.status(400).json({ error: 'Webhook URL must be a valid HTTP(S) URL' });
  }

  // Preserve existing secret if not provided in update
  const existing = getChannelConfig('webhook') || {};
  const config = {
    enabled: !!enabled,
    url: (url || '').trim(),
    secret: secret !== undefined ? secret.trim() : (existing.secret || ''),
    events: validateEvents(events),
  };

  saveChannelConfig('webhook', config);
  logger.info('Webhook notification settings updated', { enabled: config.enabled });

  const db = getDb();
  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'notif_webhook_updated', JSON.stringify({ enabled: config.enabled }),
  ]);

  res.json({
    ok: true,
    webhook: {
      enabled: config.enabled,
      url: config.url,
      hasSecret: !!config.secret,
      events: config.events,
    },
  });
});

// ---------------------------------------------------------------------------
// PUT /api/notifications/pushover — save Pushover notification config
// ---------------------------------------------------------------------------
router.put('/pushover', (req, res) => {
  const { enabled, userKey, appToken, events } = req.body || {};

  if (enabled && !userKey) {
    return res.status(400).json({ error: 'Pushover user key is required when enabled' });
  }

  // Preserve existing token if not provided in update
  const existing = getChannelConfig('pushover') || {};
  const config = {
    enabled: !!enabled,
    userKey: (userKey || '').trim(),
    appToken: appToken !== undefined ? appToken.trim() : (existing.appToken || ''),
    events: validateEvents(events),
  };

  if (enabled && !config.appToken) {
    return res.status(400).json({ error: 'Pushover application token is required when enabled' });
  }

  saveChannelConfig('pushover', config);
  logger.info('Pushover notification settings updated', { enabled: config.enabled });

  const db = getDb();
  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'notif_pushover_updated', JSON.stringify({ enabled: config.enabled }),
  ]);

  res.json({
    ok: true,
    pushover: {
      enabled: config.enabled,
      userKey: config.userKey,
      hasToken: !!config.appToken,
      events: config.events,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/notifications/:channel/test — send a test notification (stub)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PUT /api/notifications/gotify — save Gotify notification config
// ---------------------------------------------------------------------------
router.put('/gotify', (req, res) => {
  const { enabled, url, appToken, priority, events } = req.body || {};

  if (enabled && !url) {
    return res.status(400).json({ error: 'Gotify server URL is required when enabled' });
  }
  if (url && !/^https?:\/\/.+/.test(url)) {
    return res.status(400).json({ error: 'Gotify URL must be a valid HTTP(S) URL' });
  }

  const existing = getChannelConfig('gotify') || {};
  const config = {
    enabled: !!enabled,
    url: (url || '').trim().replace(/\/$/, ''),
    appToken: appToken !== undefined ? appToken.trim() : (existing.appToken || ''),
    priority: typeof priority === 'number' ? priority : 5,
    events: validateEvents(events),
  };

  if (enabled && !config.appToken) {
    return res.status(400).json({ error: 'Gotify application token is required when enabled' });
  }

  saveChannelConfig('gotify', config);
  logger.info('Gotify notification settings updated', { enabled: config.enabled });

  const db = getDb();
  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'notif_gotify_updated', JSON.stringify({ enabled: config.enabled }),
  ]);

  res.json({
    ok: true,
    gotify: {
      enabled: config.enabled,
      url: config.url,
      hasToken: !!config.appToken,
      priority: config.priority,
      events: config.events,
    },
  });
});

// ---------------------------------------------------------------------------
// PUT /api/notifications/slack — save Slack notification config
// ---------------------------------------------------------------------------
router.put('/slack', (req, res) => {
  const { enabled, webhookUrl, channel, events } = req.body || {};

  if (enabled && !webhookUrl) {
    return res.status(400).json({ error: 'Slack webhook URL is required when enabled' });
  }
  if (webhookUrl && !/^https?:\/\/.+/.test(webhookUrl)) {
    return res.status(400).json({ error: 'Slack webhook URL must be a valid HTTP(S) URL' });
  }

  const config = {
    enabled: !!enabled,
    webhookUrl: (webhookUrl || '').trim(),
    channel: (channel || '').trim(),
    events: validateEvents(events),
  };

  saveChannelConfig('slack', config);
  logger.info('Slack notification settings updated', { enabled: config.enabled });

  const db = getDb();
  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'notif_slack_updated', JSON.stringify({ enabled: config.enabled }),
  ]);

  res.json({ ok: true, slack: config });
});

// ---------------------------------------------------------------------------
// PUT /api/notifications/discord — save Discord notification config
// ---------------------------------------------------------------------------
router.put('/discord', (req, res) => {
  const { enabled, webhookUrl, events } = req.body || {};

  if (enabled && !webhookUrl) {
    return res.status(400).json({ error: 'Discord webhook URL is required when enabled' });
  }
  if (webhookUrl && !/^https?:\/\/.+/.test(webhookUrl)) {
    return res.status(400).json({ error: 'Discord webhook URL must be a valid HTTP(S) URL' });
  }

  const config = {
    enabled: !!enabled,
    webhookUrl: (webhookUrl || '').trim(),
    events: validateEvents(events),
  };

  saveChannelConfig('discord', config);
  logger.info('Discord notification settings updated', { enabled: config.enabled });

  const db = getDb();
  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'notif_discord_updated', JSON.stringify({ enabled: config.enabled }),
  ]);

  res.json({ ok: true, discord: config });
});

// ---------------------------------------------------------------------------
// PUT /api/notifications/telegram — save Telegram notification config
// ---------------------------------------------------------------------------
router.put('/telegram', (req, res) => {
  const { enabled, botToken, chatId, events } = req.body || {};

  if (enabled && !chatId) {
    return res.status(400).json({ error: 'Telegram chat ID is required when enabled' });
  }

  const existing = getChannelConfig('telegram') || {};
  const config = {
    enabled: !!enabled,
    botToken: botToken !== undefined ? botToken.trim() : (existing.botToken || ''),
    chatId: (chatId || '').trim(),
    events: validateEvents(events),
  };

  if (enabled && !config.botToken) {
    return res.status(400).json({ error: 'Telegram bot token is required when enabled' });
  }

  saveChannelConfig('telegram', config);
  logger.info('Telegram notification settings updated', { enabled: config.enabled });

  const db = getDb();
  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'notif_telegram_updated', JSON.stringify({ enabled: config.enabled }),
  ]);

  res.json({
    ok: true,
    telegram: {
      enabled: config.enabled,
      chatId: config.chatId,
      hasBotToken: !!config.botToken,
      events: config.events,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/notifications/:channel/test — send a test notification (stub)
// ---------------------------------------------------------------------------
router.post('/:channel/test', (req, res) => {
  const { channel } = req.params;
  const validChannels = ['email', 'webhook', 'pushover', 'gotify', 'slack', 'discord', 'telegram'];
  if (!validChannels.includes(channel)) {
    return res.status(400).json({ error: 'Invalid notification channel' });
  }

  const config = getChannelConfig(channel);
  if (!config || !config.enabled) {
    return res.status(400).json({ error: `${channel} notifications are not enabled` });
  }

  // TODO: Implement actual notification sending
  logger.info('Test notification requested (stub)', { channel });

  res.json({ ok: true, message: `Test ${channel} notification queued (not yet implemented)` });
});

module.exports = router;
