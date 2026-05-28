require('dotenv').config();
const { logOutreach, updateLeadStatus } = require('./db');

// ── WhatsApp via Twilio ───────────────────────────────────────

let twilioClient = null;

function getTwilio() {
  if (!twilioClient) {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
    if (!TWILIO_ACCOUNT_SID || TWILIO_ACCOUNT_SID === 'your_twilio_account_sid') {
      throw new Error('Twilio credentials not configured in .env');
    }
    const twilio = require('twilio');
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

/**
 * Send a WhatsApp message via Twilio
 * @param {string} to - recipient in format '+6591234567' (no whatsapp: prefix needed here)
 * @param {string} message - message body
 */
async function sendWhatsApp(to, message) {
  const client = getTwilio();
  const from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  const result = await client.messages.create({
    from,
    to: toFormatted,
    body: message,
  });

  console.log(`[whatsapp] Sent to ${to} — SID: ${result.sid}`);
  return result.sid;
}

/**
 * Send yourself a preview message for approval before sending to lead
 * This is the "human in the loop" step — you get the message, reply YES to send
 */
async function sendApprovalRequest(lead, message, channel) {
  const preview = `🔔 *New lead outreach draft*\n\n*Lead:* ${lead.name} (${lead.area})\n*Category:* ${lead.category === 'fnb' ? 'F&B' : 'Interior designer'}\n*Contact:* ${lead.phone || lead.email}\n*Channel:* ${channel}\n\n---\n${message}\n---\n\nReply YES to send, NO to skip.`;

  const yourNumber = process.env.YOUR_WHATSAPP;
  if (!yourNumber || yourNumber === 'whatsapp:+6591234567') {
    console.log('[approval] YOUR_WHATSAPP not set — logging approval request instead');
    console.log(preview);
    return;
  }

  await sendWhatsApp(yourNumber, preview);
  console.log(`[approval] Sent approval request for lead: ${lead.name}`);
}

// ── Telegram notifier ─────────────────────────────────────────

let telegramBot = null;

function getTelegram() {
  if (!telegramBot) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token === 'your_telegram_bot_token') return null;
    const TelegramBot = require('node-telegram-bot-api');
    telegramBot = new TelegramBot(token);
  }
  return telegramBot;
}

/**
 * Send a Telegram notification
 */
async function sendTelegram(message) {
  const bot = getTelegram();
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!bot || !chatId || chatId === 'your_telegram_chat_id') {
    console.log('[telegram] Not configured — message:', message.substring(0, 80));
    return;
  }

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  console.log('[telegram] Notification sent');
}

/**
 * Notify you when a new batch of leads is found
 */
async function notifyNewLeads(leads) {
  if (!leads.length) return;
  const lines = leads.slice(0, 10).map(l => `• ${l.name} (${l.area}) — score ${l.score}`);
  const msg = `🆕 *${leads.length} new lead${leads.length > 1 ? 's' : ''} found*\n\n${lines.join('\n')}${leads.length > 10 ? `\n...and ${leads.length - 10} more` : ''}\n\nOpen dashboard to review.`;
  await sendTelegram(msg);
}

/**
 * Notify you when a lead replies (status changes to 'replied')
 */
async function notifyLeadReplied(lead) {
  const msg = `💬 *Lead replied!*\n\n*${lead.name}* (${lead.area})\n📞 ${lead.phone || '—'}\n📧 ${lead.email || '—'}\n\nUpdate their status in the dashboard.`;
  await sendTelegram(msg);
}

/**
 * Log outreach and optionally mark lead as contacted
 */
async function recordOutreach(leadId, channel, message, markContacted = true) {
  logOutreach(leadId, channel, message);
  if (markContacted) updateLeadStatus(leadId, 'contacted');
}

module.exports = {
  sendWhatsApp,
  sendApprovalRequest,
  sendTelegram,
  notifyNewLeads,
  notifyLeadReplied,
  recordOutreach,
};
