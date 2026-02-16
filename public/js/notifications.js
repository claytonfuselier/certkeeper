/* =============================================
   CertKeeper — Notifications Page
   ============================================= */

import { $, $$, show, hide, toast } from './dom.js';
import { api } from './api.js';

// ---------- Lifecycle ----------

export function init() {
  initNotificationsTabs();
  initNotifEmailForm();
  initNotifWebhookForm();
  initNotifPushoverForm();
  initNotifGotifyForm();
  initNotifSlackForm();
  initNotifDiscordForm();
  initNotifTelegramForm();
}

export function load(params) {
  loadNotifications();

  // If a channel is specified in the route (e.g. /notifications/slack), activate that tab
  if (params && params.channel) {
    activateNotifTab(params.channel);
  }
}

// ---------- Tab Navigation ----------

function activateNotifTab(tabName) {
  $$('#notif-tabs .settings-tab').forEach((t) => t.classList.remove('active'));
  $$('#page-notifications .settings-pane').forEach((p) => p.classList.remove('active'));
  const tab = $(`#notif-tabs .settings-tab[data-notif-tab="${tabName}"]`);
  if (tab) tab.classList.add('active');
  const pane = $(`#notif-${tabName}`);
  if (pane) pane.classList.add('active');
}

function initNotificationsTabs() {
  $$('#notif-tabs .settings-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      activateNotifTab(tab.dataset.notifTab);
    });
  });
}

// ---------- Load Notifications ----------

async function loadNotifications() {
  try {
    const data = await api('GET', '/api/notifications');

    // ---- Email ----
    const email = data.email || {};
    $('#notif-email-enabled').checked = !!email.enabled;
    $('#notif-email-to').value = email.to || '';
    if (email.events) {
      $$('input[name="notif-email-event"]').forEach((cb) => {
        cb.checked = email.events.includes(cb.value);
      });
    }

    // ---- Webhook ----
    const webhook = data.webhook || {};
    $('#notif-webhook-enabled').checked = !!webhook.enabled;
    $('#notif-webhook-url').value = webhook.url || '';
    if (webhook.events) {
      $$('input[name="notif-webhook-event"]').forEach((cb) => {
        cb.checked = webhook.events.includes(cb.value);
      });
    }

    // ---- Pushover ----
    const pushover = data.pushover || {};
    $('#notif-pushover-enabled').checked = !!pushover.enabled;
    $('#notif-pushover-user').value = pushover.userKey || '';
    if (pushover.events) {
      $$('input[name="notif-pushover-event"]').forEach((cb) => {
        cb.checked = pushover.events.includes(cb.value);
      });
    }

    // ---- Gotify ----
    const gotify = data.gotify || {};
    $('#notif-gotify-enabled').checked = !!gotify.enabled;
    $('#notif-gotify-url').value = gotify.url || '';
    $('#notif-gotify-priority').value = String(gotify.priority ?? 5);
    if (gotify.events) {
      $$('input[name="notif-gotify-event"]').forEach((cb) => {
        cb.checked = gotify.events.includes(cb.value);
      });
    }

    // ---- Slack ----
    const slack = data.slack || {};
    $('#notif-slack-enabled').checked = !!slack.enabled;
    $('#notif-slack-webhook').value = slack.webhookUrl || '';
    $('#notif-slack-channel').value = slack.channel || '';
    if (slack.events) {
      $$('input[name="notif-slack-event"]').forEach((cb) => {
        cb.checked = slack.events.includes(cb.value);
      });
    }

    // ---- Discord ----
    const discord = data.discord || {};
    $('#notif-discord-enabled').checked = !!discord.enabled;
    $('#notif-discord-webhook').value = discord.webhookUrl || '';
    if (discord.events) {
      $$('input[name="notif-discord-event"]').forEach((cb) => {
        cb.checked = discord.events.includes(cb.value);
      });
    }

    // ---- Telegram ----
    const telegram = data.telegram || {};
    $('#notif-telegram-enabled').checked = !!telegram.enabled;
    $('#notif-telegram-chat-id').value = telegram.chatId || '';
    if (telegram.events) {
      $$('input[name="notif-telegram-event"]').forEach((cb) => {
        cb.checked = telegram.events.includes(cb.value);
      });
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- Helpers ----------

function collectEvents(name) {
  return $$(`input[name="${name}"]:checked`).map((cb) => cb.value);
}

// ---------- Channel Forms ----------

function initNotifEmailForm() {
  const form = $('#notif-email-form');
  const errorEl = $('#notif-email-error');
  const successEl = $('#notif-email-success');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hide(errorEl);
    hide(successEl);
    try {
      await api('PUT', '/api/notifications/email', {
        enabled: $('#notif-email-enabled').checked,
        to: $('#notif-email-to').value.trim(),
        events: collectEvents('notif-email-event'),
      });
      successEl.textContent = 'Email notification settings saved.';
      show(successEl);
      toast('Email notifications saved', 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    }
  });

  $('#notif-email-test-btn').addEventListener('click', async () => {
    try {
      await api('POST', '/api/notifications/email/test');
      toast('Test email sent', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function initNotifWebhookForm() {
  const form = $('#notif-webhook-form');
  const errorEl = $('#notif-webhook-error');
  const successEl = $('#notif-webhook-success');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hide(errorEl);
    hide(successEl);
    try {
      const body = {
        enabled: $('#notif-webhook-enabled').checked,
        url: $('#notif-webhook-url').value.trim(),
        events: collectEvents('notif-webhook-event'),
      };
      const secret = $('#notif-webhook-secret').value.trim();
      if (secret) body.secret = secret;
      await api('PUT', '/api/notifications/webhook', body);
      successEl.textContent = 'Webhook notification settings saved.';
      show(successEl);
      toast('Webhook notifications saved', 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    }
  });

  $('#notif-webhook-test-btn').addEventListener('click', async () => {
    try {
      await api('POST', '/api/notifications/webhook/test');
      toast('Test webhook sent', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function initNotifPushoverForm() {
  const form = $('#notif-pushover-form');
  const errorEl = $('#notif-pushover-error');
  const successEl = $('#notif-pushover-success');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hide(errorEl);
    hide(successEl);
    try {
      const body = {
        enabled: $('#notif-pushover-enabled').checked,
        userKey: $('#notif-pushover-user').value.trim(),
        events: collectEvents('notif-pushover-event'),
      };
      const token = $('#notif-pushover-token').value.trim();
      if (token) body.appToken = token;
      await api('PUT', '/api/notifications/pushover', body);
      successEl.textContent = 'Pushover notification settings saved.';
      show(successEl);
      toast('Pushover notifications saved', 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    }
  });

  $('#notif-pushover-test-btn').addEventListener('click', async () => {
    try {
      await api('POST', '/api/notifications/pushover/test');
      toast('Test push sent', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function initNotifGotifyForm() {
  const form = $('#notif-gotify-form');
  const errorEl = $('#notif-gotify-error');
  const successEl = $('#notif-gotify-success');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hide(errorEl);
    hide(successEl);
    try {
      const body = {
        enabled: $('#notif-gotify-enabled').checked,
        url: $('#notif-gotify-url').value.trim(),
        priority: parseInt($('#notif-gotify-priority').value, 10),
        events: collectEvents('notif-gotify-event'),
      };
      const token = $('#notif-gotify-token').value.trim();
      if (token) body.appToken = token;
      await api('PUT', '/api/notifications/gotify', body);
      successEl.textContent = 'Gotify notification settings saved.';
      show(successEl);
      toast('Gotify notifications saved', 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    }
  });

  $('#notif-gotify-test-btn').addEventListener('click', async () => {
    try {
      await api('POST', '/api/notifications/gotify/test');
      toast('Test Gotify message sent', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function initNotifSlackForm() {
  const form = $('#notif-slack-form');
  const errorEl = $('#notif-slack-error');
  const successEl = $('#notif-slack-success');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hide(errorEl);
    hide(successEl);
    try {
      await api('PUT', '/api/notifications/slack', {
        enabled: $('#notif-slack-enabled').checked,
        webhookUrl: $('#notif-slack-webhook').value.trim(),
        channel: $('#notif-slack-channel').value.trim(),
        events: collectEvents('notif-slack-event'),
      });
      successEl.textContent = 'Slack notification settings saved.';
      show(successEl);
      toast('Slack notifications saved', 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    }
  });

  $('#notif-slack-test-btn').addEventListener('click', async () => {
    try {
      await api('POST', '/api/notifications/slack/test');
      toast('Test Slack message sent', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function initNotifDiscordForm() {
  const form = $('#notif-discord-form');
  const errorEl = $('#notif-discord-error');
  const successEl = $('#notif-discord-success');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hide(errorEl);
    hide(successEl);
    try {
      await api('PUT', '/api/notifications/discord', {
        enabled: $('#notif-discord-enabled').checked,
        webhookUrl: $('#notif-discord-webhook').value.trim(),
        events: collectEvents('notif-discord-event'),
      });
      successEl.textContent = 'Discord notification settings saved.';
      show(successEl);
      toast('Discord notifications saved', 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    }
  });

  $('#notif-discord-test-btn').addEventListener('click', async () => {
    try {
      await api('POST', '/api/notifications/discord/test');
      toast('Test Discord message sent', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function initNotifTelegramForm() {
  const form = $('#notif-telegram-form');
  const errorEl = $('#notif-telegram-error');
  const successEl = $('#notif-telegram-success');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hide(errorEl);
    hide(successEl);
    try {
      const body = {
        enabled: $('#notif-telegram-enabled').checked,
        chatId: $('#notif-telegram-chat-id').value.trim(),
        events: collectEvents('notif-telegram-event'),
      };
      const token = $('#notif-telegram-bot-token').value.trim();
      if (token) body.botToken = token;
      await api('PUT', '/api/notifications/telegram', body);
      successEl.textContent = 'Telegram notification settings saved.';
      show(successEl);
      toast('Telegram notifications saved', 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    }
  });

  $('#notif-telegram-test-btn').addEventListener('click', async () => {
    try {
      await api('POST', '/api/notifications/telegram/test');
      toast('Test Telegram message sent', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
