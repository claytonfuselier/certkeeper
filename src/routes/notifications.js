const express = require('express');
const { getDb } = require('../db');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { encrypt, decrypt } = require('../services/encryption');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_EVENTS = ['issued', 'renewed', 'expiry_warning', 'error', 'revoked', 'agent_offline', 'agent_online'];
const DEFAULT_EVENTS = ['issued', 'renewed', 'expiry_warning', 'error'];

function getChannelConfig(channel) {
  const db = getDb();
  const row = db.get('SELECT value FROM settings WHERE key = ?', [`notif_${channel}`]);
  if (!row) return null;
  try {
    const decrypted = decrypt(row.value);
    return JSON.parse(decrypted);
  } catch { return null; }
}

function saveChannelConfig(channel, cfg) {
  const db = getDb();
  const encrypted = encrypt(JSON.stringify(cfg));
  db.upsertSetting(`notif_${channel}`, encrypted);
}

function validateEvents(events) {
  if (!Array.isArray(events)) return DEFAULT_EVENTS;
  return events.filter((e) => VALID_EVENTS.includes(e));
}

/** Save channel config and log the change to audit_log. */
function saveChannelAndAudit(channel, channelConfig) {
  saveChannelConfig(channel, channelConfig);
  logger.info(`${channel} notification settings updated`, { enabled: channelConfig.enabled });
  const db = getDb();
  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    `notif_${channel}_updated`, JSON.stringify({ enabled: channelConfig.enabled }),
  ]);
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

  const channelCfg = {
    enabled: !!enabled,
    to: (to || '').trim(),
    events: validateEvents(events),
  };

  saveChannelAndAudit('email', channelCfg);

  res.json({ ok: true, email: channelCfg });
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
  const channelCfg = {
    enabled: !!enabled,
    url: (url || '').trim(),
    secret: secret !== undefined ? secret.trim() : (existing.secret || ''),
    events: validateEvents(events),
  };

  saveChannelAndAudit('webhook', channelCfg);

  res.json({
    ok: true,
    webhook: {
      enabled: channelCfg.enabled,
      url: channelCfg.url,
      hasSecret: !!channelCfg.secret,
      events: channelCfg.events,
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
  const channelCfg = {
    enabled: !!enabled,
    userKey: (userKey || '').trim(),
    appToken: appToken !== undefined ? appToken.trim() : (existing.appToken || ''),
    events: validateEvents(events),
  };

  if (enabled && !channelCfg.appToken) {
    return res.status(400).json({ error: 'Pushover application token is required when enabled' });
  }

  saveChannelAndAudit('pushover', channelCfg);

  res.json({
    ok: true,
    pushover: {
      enabled: channelCfg.enabled,
      userKey: channelCfg.userKey,
      hasToken: !!channelCfg.appToken,
      events: channelCfg.events,
    },
  });
});

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
  const channelCfg = {
    enabled: !!enabled,
    url: (url || '').trim().replace(/\/$/, ''),
    appToken: appToken !== undefined ? appToken.trim() : (existing.appToken || ''),
    priority: typeof priority === 'number' ? priority : 5,
    events: validateEvents(events),
  };

  if (enabled && !channelCfg.appToken) {
    return res.status(400).json({ error: 'Gotify application token is required when enabled' });
  }

  saveChannelAndAudit('gotify', channelCfg);

  res.json({
    ok: true,
    gotify: {
      enabled: channelCfg.enabled,
      url: channelCfg.url,
      hasToken: !!channelCfg.appToken,
      priority: channelCfg.priority,
      events: channelCfg.events,
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

  const channelCfg = {
    enabled: !!enabled,
    webhookUrl: (webhookUrl || '').trim(),
    channel: (channel || '').trim(),
    events: validateEvents(events),
  };

  saveChannelAndAudit('slack', channelCfg);

  res.json({ ok: true, slack: channelCfg });
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

  const channelCfg = {
    enabled: !!enabled,
    webhookUrl: (webhookUrl || '').trim(),
    events: validateEvents(events),
  };

  saveChannelAndAudit('discord', channelCfg);

  res.json({ ok: true, discord: channelCfg });
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
  const channelCfg = {
    enabled: !!enabled,
    botToken: botToken !== undefined ? botToken.trim() : (existing.botToken || ''),
    chatId: (chatId || '').trim(),
    events: validateEvents(events),
  };

  if (enabled && !channelCfg.botToken) {
    return res.status(400).json({ error: 'Telegram bot token is required when enabled' });
  }

  saveChannelAndAudit('telegram', channelCfg);

  res.json({
    ok: true,
    telegram: {
      enabled: channelCfg.enabled,
      chatId: channelCfg.chatId,
      hasBotToken: !!channelCfg.botToken,
      events: channelCfg.events,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/notifications/:channel/test — send a test notification (stub)
// ---------------------------------------------------------------------------
router.post('/:channel/test', (req, res) => {
  try {
    const { channel } = req.params;
    const validChannels = ['email', 'webhook', 'pushover', 'gotify', 'slack', 'discord', 'telegram'];
    if (!validChannels.includes(channel)) {
      return res.status(400).json({ error: 'Invalid notification channel' });
    }

    const channelCfg = getChannelConfig(channel);
    if (!channelCfg || !channelCfg.enabled) {
      return res.status(400).json({ error: `${channel} notifications are not enabled` });
    }

    // TODO: Implement actual notification sending
    logger.info('Test notification requested (stub)', { channel });

    res.json({ ok: true, message: `Test ${channel} notification queued (not yet implemented)` });
  } catch (err) {
    logger.error('Test notification error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
