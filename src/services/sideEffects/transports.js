import nodemailer from 'nodemailer';
import { config } from '../../lib/config.js';
import { logger } from '../../lib/logger.js';

/**
 * How a confirmation actually leaves the building. Which one is used is env-driven:
 *
 *   console — log it (the brief's default; nothing to install)
 *   smtp    — send through the Mailpit container on :1025
 *   webhook — POST the payload to SIDE_EFFECT_WEBHOOK_URL
 *   fail    — always throw
 *
 * `fail` exists on purpose. PROBE 5 asks that a throwing side effect still
 * leaves the submission stored, and a switch is a far more honest proof than
 * commenting out a line and taking a screenshot.
 */

let mailer = null;
function smtpTransport() {
  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: false,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
      // Mailpit accepts anything; don't let a self-signed cert become an outage.
      tls: { rejectUnauthorized: false },
    });
  }
  return mailer;
}

const transports = {
  async console(payload) {
    logger.info('side effect: confirmation (console transport)', {
      submission_id: payload.submission_id,
      widget: payload.widget_title,
      to: payload.to ?? '(no email field on this widget)',
    });
    return { transport: 'console' };
  },

  async smtp(payload) {
    if (!payload.to) return { transport: 'smtp', skipped: 'no recipient address' };
    const info = await smtpTransport().sendMail({
      from: config.SMTP_FROM,
      to: payload.to,
      subject: `Thanks for contacting ${payload.widget_title}`,
      text: `We received your submission.\n\nReference: ${payload.submission_id}`,
    });
    return { transport: 'smtp', message_id: info.messageId };
  },

  async webhook(payload) {
    if (!config.SIDE_EFFECT_WEBHOOK_URL) throw new Error('SIDE_EFFECT_WEBHOOK_URL is not set');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(config.SIDE_EFFECT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`webhook responded ${res.status}`);
      return { transport: 'webhook', status: res.status };
    } finally {
      clearTimeout(timer);
    }
  },

  async fail() {
    throw new Error('Forced side-effect failure (SIDE_EFFECT_TRANSPORT=fail)');
  },
};

export async function dispatchSideEffect(payload) {
  const transport = transports[config.SIDE_EFFECT_TRANSPORT];
  if (!transport) throw new Error(`Unknown side effect transport: ${config.SIDE_EFFECT_TRANSPORT}`);
  return transport(payload);
}
