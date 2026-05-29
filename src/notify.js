require('dotenv').config();
const { logOutreach, updateLeadStatus } = require('./db');

// ── Telegram ──────────────────────────────────────────────────
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

async function sendTelegram(message) {
  const bot    = getTelegram();
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!bot || !chatId || chatId === 'your_telegram_chat_id') {
    console.log('[telegram] Not configured:', message.substring(0, 80));
    return;
  }
  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  console.log('[telegram] Sent');
}

// ── Morning brief ─────────────────────────────────────────────
/**
 * Sent at 9:15am Mon–Fri.
 * Monday includes urgency scoring for the weekend backlog.
 * 
 * Priority ranking (80/20 focus — get sales, not just activity):
 * 🔴 CRITICAL — replied leads with no next step (revenue at risk right now)
 * 🟠 HIGH     — follow-ups overdue 2+ days (reply window closing fast)
 * 🟡 MEDIUM   — follow-ups due today
 * 🟢 NEW      — hot uncontacted leads (score 75+, equipment signal)
 */
async function sendMorningBrief({ followUps, needNext, hotLeads, isMonday }) {
  const today   = new Date().toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'short' });
  const lines   = [];
  const intro   = isMonday
    ? `Good morning JJ! 🌅 It's Monday — here's everything that needs your attention after the weekend.`
    : `Good morning JJ! 🌅 Here's your sales priority list for ${today}.`;

  lines.push(intro);
  lines.push('');

  // ── CRITICAL: replied leads with no next step ──────────────
  if (needNext.length > 0) {
    lines.push('🔴 *CRITICAL — Reply received, action needed:*');
    needNext.slice(0, 5).forEach(l => {
      lines.push(`• *${l.name}* (${l.area || 'SG'}) — score ${l.score} — log what they said and what you owe them`);
    });
    if (needNext.length > 5) lines.push(`  _...and ${needNext.length - 5} more_`);
    lines.push('');
  }

  // ── HIGH / MEDIUM: follow-ups due ─────────────────────────
  if (followUps.length > 0) {
    const now      = Date.now();
    const overdue2 = followUps.filter(l => {
      const contacted = new Date(l.last_contacted_at).getTime();
      return (now - contacted) > 2 * 24 * 60 * 60 * 1000;
    });
    const dueSoon  = followUps.filter(l => {
      const contacted = new Date(l.last_contacted_at).getTime();
      return (now - contacted) <= 2 * 24 * 60 * 60 * 1000;
    });

    if (overdue2.length > 0) {
      lines.push('🟠 *HIGH — Follow-up overdue 2+ days:*');
      overdue2.slice(0, 5).forEach(l => {
        const daysAgo = Math.floor((now - new Date(l.last_contacted_at).getTime()) / 86400000);
        const urgency = isMonday && daysAgo >= 3 ? ' ⚠️ _window closing_' : '';
        lines.push(`• *${l.name}* (${l.area || 'SG'}) — contacted ${daysAgo}d ago${urgency}`);
      });
      lines.push('');
    }

    if (dueSoon.length > 0) {
      lines.push('🟡 *MEDIUM — Follow up today:*');
      dueSoon.slice(0, 5).forEach(l => {
        lines.push(`• *${l.name}* (${l.area || 'SG'}) — score ${l.score}`);
      });
      lines.push('');
    }
  }

  // ── NEW: hot leads worth contacting ───────────────────────
  // Only surfaces high-score leads so you're not wasting time on weak ones
  const hotFiltered = hotLeads.filter(l => l.score >= 70);
  if (hotFiltered.length > 0) {
    lines.push('🟢 *NEW — Worth contacting today (score 70+):*');
    hotFiltered.slice(0, 5).forEach(l => {
      const tag = l.is_solo ? '👤 owner-op' : l.is_chain ? '🏢 chain' : '🏪 mid-size';
      lines.push(`• *${l.name}* (${l.area || 'SG'}) — score ${l.score} ${tag}`);
    });
    lines.push('');
  }

  // ── Monday urgency summary ─────────────────────────────────
  if (isMonday) {
    const totalUrgent = needNext.length + followUps.length;
    if (totalUrgent > 0) {
      const urgencyLevel = totalUrgent >= 10 ? '🚨 Heavy day ahead'
        : totalUrgent >= 5  ? '⚡ Busy morning'
        : '✅ Manageable';
      lines.push(`*Weekend backlog: ${totalUrgent} items need attention — ${urgencyLevel}*`);
      lines.push('');
    }
  }

  // ── Summary ────────────────────────────────────────────────
  const totalTasks = needNext.length + followUps.length + hotFiltered.length;
  if (totalTasks === 0) {
    lines.push('✨ Nothing urgent today — good time to reach out to new leads!');
  } else {
    lines.push(`_${totalTasks} task${totalTasks > 1 ? 's' : ''} total — focus on the red and orange ones first._`);
  }

  await sendTelegram(lines.join('\n'));
}

// ── Lead notifications ────────────────────────────────────────
async function notifyNewLeads(leads) {
  if (!leads.length) return;
  const lines = leads.slice(0, 10).map(l =>
    `• ${l.name} (${l.area || 'SG'}) — score ${l.score}${l.instagram ? ' 📸' : ''}`
  );
  const msg = `🆕 *${leads.length} new lead${leads.length > 1 ? 's' : ''} scraped*\n\n${lines.join('\n')}${leads.length > 10 ? `\n_...and ${leads.length - 10} more_` : ''}\n\nOpen dashboard to review.`;
  await sendTelegram(msg);
}

async function notifyLeadReplied(lead) {
  const msg = [
    `💬 *${lead.name}* replied!`,
    ``,
    `📍 ${lead.area || 'Singapore'}`,
    `📞 ${lead.phone || '—'}`,
    `📧 ${lead.email || '—'}`,
    `${lead.instagram ? '📸 @' + lead.instagram : ''}`,
    ``,
    `Score: ${lead.score} | ${lead.subcategory || lead.category}`,
    ``,
    `_Log their reply and next step in the dashboard._`,
  ].filter(l => l !== undefined).join('\n');
  await sendTelegram(msg);
}

// ── WhatsApp via Twilio ───────────────────────────────────────
let twilioClient = null;

function getTwilio() {
  if (!twilioClient) {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
    if (!TWILIO_ACCOUNT_SID || TWILIO_ACCOUNT_SID === 'your_twilio_account_sid') {
      throw new Error('Twilio credentials not configured');
    }
    twilioClient = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

async function sendWhatsApp(to, message) {
  const client      = getTwilio();
  const from        = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const result      = await client.messages.create({ from, to: toFormatted, body: message });
  console.log(`[whatsapp] Sent to ${to} — SID: ${result.sid}`);
  return result.sid;
}

async function sendApprovalRequest(lead, message, channel) {
  const preview = [
    `🔔 *Outreach draft*`,
    ``,
    `*Lead:* ${lead.name} (${lead.area || 'SG'})`,
    `*Score:* ${lead.score} | *Variant:* ${lead.ab_variant || '—'}`,
    `*Contact:* ${lead.phone || lead.email}`,
    `*Channel:* ${channel}`,
    ``,
    `---`,
    message,
    `---`,
    ``,
    `Reply YES to send, NO to skip.`,
  ].join('\n');

  const yourNumber = process.env.YOUR_WHATSAPP;
  if (!yourNumber || yourNumber === 'whatsapp:+6591234567') {
    console.log('[approval] YOUR_WHATSAPP not set — logging instead');
    console.log(preview);
    return;
  }
  await sendWhatsApp(yourNumber, preview);
}

async function recordOutreach(leadId, channel, message, markContacted = true) {
  logOutreach(leadId, channel, message);
  if (markContacted) updateLeadStatus(leadId, 'contacted');
}

module.exports = {
  sendTelegram, sendWhatsApp, sendApprovalRequest,
  notifyNewLeads, notifyLeadReplied, recordOutreach,
  sendMorningBrief,
};