/* =============================================
   CertKeeper — Notifications Page
   ============================================= */

import { $, $$, show, hide, toast } from './dom.js';
import { api } from './api.js';

// ---------- Lifecycle ----------

export function init() {
  initNotificationsTabs();

  initNotifForm('email', () => ({
    enabled: $('#notif-email-enabled').checked,
    to: $('#notif-email-to').value.trim(),
    events: collectEvents('notif-email-event'),
  }));

  initNotifForm('webhook', () => {
    const body = {
      enabled: $('#notif-webhook-enabled').checked,
      url: $('#notif-webhook-url').value.trim(),
      events: collectEvents('notif-webhook-event'),
    };
    const secret = $('#notif-webhook-secret').value.trim();
    if (secret) body.secret = secret;
    return body;
  });

  initNotifForm('pushover', () => {
    const body = {
      enabled: $('#notif-pushover-enabled').checked,
      userKey: $('#notif-pushover-user').value.trim(),
      events: collectEvents('notif-pushover-event'),
    };
    const token = $('#notif-pushover-token').value.trim();
    if (token) body.appToken = token;
    return body;
  });

  initNotifForm('gotify', () => {
    const body = {
      enabled: $('#notif-gotify-enabled').checked,
      url: $('#notif-gotify-url').value.trim(),
      priority: parseInt($('#notif-gotify-priority').value, 10),
      events: collectEvents('notif-gotify-event'),
    };
    const token = $('#notif-gotify-token').value.trim();
    if (token) body.appToken = token;
    return body;
  });

  initNotifForm('slack', () => ({
    enabled: $('#notif-slack-enabled').checked,
    webhookUrl: $('#notif-slack-webhook').value.trim(),
    channel: $('#notif-slack-channel').value.trim(),
    events: collectEvents('notif-slack-event'),
  }));

  initNotifForm('discord', () => ({
    enabled: $('#notif-discord-enabled').checked,
    webhookUrl: $('#notif-discord-webhook').value.trim(),
    events: collectEvents('notif-discord-event'),
  }));

  initNotifForm('telegram', () => {
    const body = {
      enabled: $('#notif-telegram-enabled').checked,
      chatId: $('#notif-telegram-chat-id').value.trim(),
      events: collectEvents('notif-telegram-event'),
    };
    const token = $('#notif-telegram-bot-token').value.trim();
    if (token) body.botToken = token;
    return body;
  });
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

// ---------- Channel Form Factory ----------

function initNotifForm(channel, buildBody) {
  const label = channel.charAt(0).toUpperCase() + channel.slice(1);
  const form = $(`#notif-${channel}-form`);
  const errorEl = $(`#notif-${channel}-error`);
  const successEl = $(`#notif-${channel}-success`);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hide(errorEl);
    hide(successEl);
    try {
      await api('PUT', `/api/notifications/${channel}`, buildBody());
      successEl.textContent = `${label} notification settings saved.`;
      show(successEl);
      toast(`${label} notifications saved`, 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    }
  });

  $(`#notif-${channel}-test-btn`).addEventListener('click', async () => {
    try {
      await api('POST', `/api/notifications/${channel}/test`);
      toast(`Test ${label} notification sent`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
