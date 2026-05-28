require('dotenv').config();
const axios = require('axios');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `You are a B2B sales copywriter for a Singapore-based commercial kitchenware supplier. 
Products include: countertop chillers, display chillers, cake display chillers, commercial stoves, 
induction cookers, dishwashers, vertical deep fryers, and all types of commercial kitchen equipment.

Your job is to write short, warm, conversational cold outreach messages that spark genuine curiosity 
and invite a reply. Never be pushy or salesy. Never list prices. Never use emojis in emails.
The goal is a conversation, not a hard sell.

Always sign off as "The Kitchen Co team" — no phone number or website link in the message.
Keep messages under 80 words for WhatsApp, under 120 words for email.`;

const PROMPTS = {
  fnb: {
    whatsapp: (lead) => `Write a WhatsApp cold outreach message to "${lead.name}", an F&B business in ${lead.area}, Singapore (subcategory: ${lead.subcategory}). 
Focus on ONE of: equipment reliability reducing downtime, upgrading display chillers to boost product visibility, or energy-efficient equipment cutting costs.
Pick whichever angle feels most relevant for a ${lead.subcategory}. Keep it under 80 words. Use 1-2 emojis max. Be warm and direct.`,

    email: (lead) => `Write a cold email to "${lead.name}", an F&B business in ${lead.area}, Singapore (subcategory: ${lead.subcategory}).
Start with "Subject: " on the first line, then a blank line, then the email body.
Focus on a specific pain point for a ${lead.subcategory}: equipment downtime, display presentation, or operational efficiency.
Under 120 words. Professional but friendly tone. No emojis.`,
  },

  id: {
    whatsapp: (lead) => `Write a WhatsApp cold outreach message to "${lead.name}", a commercial interior design firm in ${lead.area}, Singapore.
Angle: propose a trade/referral partnership — we supply commercial kitchen equipment they can recommend or spec into F&B fit-out projects.
Position it as adding value to their clients, not just a sales pitch. Under 80 words. Warm and professional. 1 emoji max.`,

    email: (lead) => `Write a cold email to "${lead.name}", a commercial interior design firm in ${lead.area}, Singapore.
Start with "Subject: " on the first line, then a blank line, then the email body.
Propose a trade partnership — we supply commercial kitchen equipment for F&B fit-outs. 
Focus on: making their client projects easier, trade pricing, and joint value creation.
Under 120 words. No emojis. Professional tone.`,
  },
};

async function generateOutreach(lead, channel = 'whatsapp') {
  const cat = lead.category || 'fnb';
  const promptFn = PROMPTS[cat]?.[channel] || PROMPTS.fnb.whatsapp;
  const userPrompt = promptFn(lead);

  const res = await axios.post(ANTHROPIC_API, {
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  }, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
  });

  const text = res.data.content?.map(b => b.text || '').join('') || '';
  return text.trim();
}

module.exports = { generateOutreach };