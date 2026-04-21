/**
 * Alert notification channels — Slack, DingTalk (钉钉), and Email.
 *
 * Each channel exposes a send(alert, config) function.
 * The unified sendAlert() dispatcher routes to the correct channel.
 *
 * Email requires nodemailer: npm install nodemailer
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('alert-notifier');

// ─── Slack ────────────────────────────────────────────────────────────────────

/**
 * Send an alert to a Slack channel via Incoming Webhook.
 *
 * @param {Object} alert - { title, message, severity, jobId, workflowName }
 * @param {Object} config
 * @param {string} config.webhookUrl - Slack Incoming Webhook URL
 * @param {string} [config.channel] - Override channel (optional)
 * @param {string} [config.username='OmniCrawl']
 * @param {string} [config.iconEmoji=':spider_web:']
 */
export async function sendSlackAlert(alert, config) {
  const severityColor = { info: '#36a64f', warning: '#ff9900', error: '#e01e5a', critical: '#8b0000' };
  const color = severityColor[alert.severity ?? 'info'] ?? '#36a64f';

  const payload = {
    username: config.username ?? 'OmniCrawl',
    icon_emoji: config.iconEmoji ?? ':spider_web:',
    ...(config.channel ? { channel: config.channel } : {}),
    attachments: [{
      color,
      title: alert.title ?? 'OmniCrawl Alert',
      text: alert.message ?? '',
      fields: [
        alert.jobId && { title: 'Job ID', value: alert.jobId, short: true },
        alert.workflowName && { title: 'Workflow', value: alert.workflowName, short: true },
        { title: 'Severity', value: (alert.severity ?? 'info').toUpperCase(), short: true },
        { title: 'Time', value: new Date().toISOString(), short: true },
      ].filter(Boolean),
      footer: 'OmniCrawl',
      ts: Math.floor(Date.now() / 1000),
    }],
  };

  const res = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.timeoutMs ?? 8000),
  });

  if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
  log.info('slack alert sent', { jobId: alert.jobId, severity: alert.severity });
}

// ─── DingTalk (钉钉) ──────────────────────────────────────────────────────────

/**
 * Send an alert to DingTalk via custom robot webhook.
 *
 * @param {Object} alert
 * @param {Object} config
 * @param {string} config.webhookUrl - DingTalk robot webhook URL (includes access_token)
 * @param {string} [config.secret] - Signing secret for timestamp-based signature
 * @param {string[]} [config.atMobiles] - Phone numbers to @mention
 * @param {boolean} [config.atAll=false]
 */
export async function sendDingTalkAlert(alert, config) {
  let url = config.webhookUrl;

  // Add HMAC-SHA256 signature if secret is provided
  if (config.secret) {
    const timestamp = Date.now();
    const sign = await computeDingTalkSign(timestamp, config.secret);
    url = `${url}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }

  const severityEmoji = { info: '✅', warning: '⚠️', error: '❌', critical: '🚨' };
  const emoji = severityEmoji[alert.severity ?? 'info'] ?? 'ℹ️';

  const text = [
    `${emoji} **${alert.title ?? 'OmniCrawl Alert'}**`,
    '',
    alert.message ?? '',
    '',
    `- **Severity**: ${(alert.severity ?? 'info').toUpperCase()}`,
    alert.jobId ? `- **Job ID**: ${alert.jobId}` : null,
    alert.workflowName ? `- **Workflow**: ${alert.workflowName}` : null,
    `- **Time**: ${new Date().toISOString()}`,
  ].filter((line) => line !== null).join('\n');

  const payload = {
    msgtype: 'markdown',
    markdown: {
      title: alert.title ?? 'OmniCrawl Alert',
      text,
    },
    at: {
      atMobiles: config.atMobiles ?? [],
      isAtAll: config.atAll ?? false,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.timeoutMs ?? 8000),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errcode !== 0) {
    throw new Error(`DingTalk webhook error: ${body.errmsg ?? res.status}`);
  }
  log.info('dingtalk alert sent', { jobId: alert.jobId });
}

async function computeDingTalkSign(timestamp, secret) {
  const { createHmac } = await import('node:crypto');
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac('sha256', secret).update(stringToSign).digest('base64');
}

// ─── Email ────────────────────────────────────────────────────────────────────

/**
 * Send an alert via email using nodemailer.
 *
 * @param {Object} alert
 * @param {Object} config
 * @param {string} config.host - SMTP host
 * @param {number} [config.port=587]
 * @param {boolean} [config.secure=false]
 * @param {string} config.user - SMTP username
 * @param {string} config.pass - SMTP password
 * @param {string} config.from - Sender address
 * @param {string|string[]} config.to - Recipient address(es)
 * @param {string} [config.subject]
 */
export async function sendEmailAlert(alert, config) {
  const nodemailer = await import('nodemailer').catch(() => {
    throw new Error('Email alerts require nodemailer: npm install nodemailer');
  });

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port ?? 587,
    secure: config.secure ?? false,
    auth: { user: config.user, pass: config.pass },
  });

  const severityLabel = (alert.severity ?? 'info').toUpperCase();
  const subject = config.subject ?? `[OmniCrawl ${severityLabel}] ${alert.title ?? 'Alert'}`;

  const html = `
<h2>${alert.title ?? 'OmniCrawl Alert'}</h2>
<p><strong>Severity:</strong> ${severityLabel}</p>
${alert.jobId ? `<p><strong>Job ID:</strong> ${alert.jobId}</p>` : ''}
${alert.workflowName ? `<p><strong>Workflow:</strong> ${alert.workflowName}</p>` : ''}
<p><strong>Time:</strong> ${new Date().toISOString()}</p>
<hr/>
<p>${(alert.message ?? '').replace(/\n/g, '<br/>')}</p>
`;

  await transporter.sendMail({
    from: config.from,
    to: Array.isArray(config.to) ? config.to.join(', ') : config.to,
    subject,
    html,
    text: `${subject}\n\n${alert.message ?? ''}`,
  });

  log.info('email alert sent', { jobId: alert.jobId, to: config.to });
}

// ─── Unified dispatcher ───────────────────────────────────────────────────────

/**
 * Send an alert through one or more configured channels.
 *
 * @param {Object} alert - { title, message, severity, jobId, workflowName }
 * @param {Object[]} channels - Array of channel configs with a `type` field
 * @param {'slack'|'dingtalk'|'email'} channels[].type
 * @returns {Promise<{ channel: string, ok: boolean, error?: string }[]>}
 */
export async function sendAlert(alert, channels = []) {
  const results = await Promise.allSettled(
    channels.map(async (ch) => {
      switch (ch.type) {
        case 'slack': await sendSlackAlert(alert, ch); break;
        case 'dingtalk': await sendDingTalkAlert(alert, ch); break;
        case 'email': await sendEmailAlert(alert, ch); break;
        default: throw new Error(`Unknown alert channel type: ${ch.type}`);
      }
      return { channel: ch.type, ok: true };
    }),
  );

  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { channel: channels[i]?.type ?? 'unknown', ok: false, error: r.reason?.message ?? String(r.reason) },
  );
}
