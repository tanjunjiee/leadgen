require('dotenv').config();
const axios = require('axios');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

/**
 * Build a review context string from stored snippets.
 * Keeps it short — we only need the most useful signal, not all 4 reviews.
 */
function buildReviewContext(lead) {
  const snippets = lead.review_snippets || [];
  if (snippets.length === 0) return '';
  // Pick the most informative review (longest text)
  const best = snippets.sort((a, b) => (b.text || '').length - (a.text || '').length)[0];
  return best.text ? `Recent customer review: "${best.text.slice(0, 200)}"` : '';
}

/**
 * Build buying signal context from review snippets.
 */
function buildSignalContext(lead) {
  const snippets = lead.review_snippets || [];
  const text = snippets.map(r => r.text || '').join(' ').toLowerCase();
  const signals = [];

  if (/not cold|warm drink|chiller|fridge broke|freezer/.test(text)) signals.push('equipment temperature complaint in reviews');
  if (/new outlet|opening soon|expansion|second location/.test(text)) signals.push('expansion signals in reviews');
  if (/renovation|reno|closed for|reopening/.test(text)) signals.push('renovation mentioned in reviews');
  if (/long wait|slow kitchen|waited forever/.test(text)) signals.push('kitchen speed complaints in reviews');
  if (/dirty plate|dirty cup|not clean/.test(text)) signals.push('dishwashing complaints in reviews');

  return signals.length > 0 ? `Detected signals: ${signals.join(', ')}.` : '';
}

/**
 * Generate outreach message — synced with dashboard templates.
 * Uses Haiku for speed and cost efficiency.
 * Review data and signals are passed as context so messages are personalised.
 */
async function generateOutreach(lead, channel = 'whatsapp') {
  const sub  = (lead.subcategory || '').toLowerCase();
  const cat  = (lead.category || 'fnb').toLowerCase();
  const area = lead.area || 'Singapore';
  const name = lead.name || 'your business';
  const reviewContext = buildReviewContext(lead);
  const signalContext = buildSignalContext(lead);

  // Build a tight, context-aware prompt
  const contextBlock = [reviewContext, signalContext].filter(Boolean).join(' ');

  const systemPrompt = `You write short, warm WhatsApp cold outreach messages for JJ from Stellar Kitchenware, a commercial kitchen equipment supplier in Singapore. 
Products: display chillers, undercounter chillers, cake display chillers, dishwashers, combi ovens, blast chillers, ice makers, commercial stoves.
Rules: casual and friendly, like a text from someone useful. No em dashes. No bullet points. No numbered lists. No "not a sales pitch". No "happy to chat". Under 120 words. Sign off as "JJ from Stellar Kitchenware".`;

  // Subcategory-specific angle instructions
  const angles = {
    cafe:       'Focus on: beverage display chillers boosting grab-and-go sales, undercounter chillers saving counter space, or dishwasher labour savings.',
    bakery:     'Focus on: cake display chiller temperature consistency for shelf life and presentation, or servicing/repairs for existing display units.',
    dessert:    'Focus on: undercounter chillers for bubble tea workflow, display chillers as a passive sales tool for pre-made desserts.',
    restaurant: 'Focus on: undercounter prep chillers at the station for food safety and efficiency, or dishwasher spec matching cover count.',
    catering:   'Focus on: combi ovens cutting cook time at volume, blast chillers as a food safety requirement for cook-chill operations.',
    id_firm:    'Angle: propose a referral/partnership arrangement — we handle equipment specs and supply for their F&B fit-out clients, removing that workload from them.',
  };

  const angle = angles[sub] || angles[cat === 'id' ? 'id_firm' : 'cafe'];

  const userPrompt = `Write a WhatsApp outreach message to ${name}, a ${sub || cat} in ${area}, Singapore.
${contextBlock ? contextBlock + '\n' : ''}${angle}
${signalContext ? 'Lead with the most relevant signal detected above.' : 'Open with a genuine observation about this type of business in their area.'}
Keep it under 120 words. Warm, casual, helpful tone.`;

  const res = await axios.post(ANTHROPIC_API, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 250,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  }, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    timeout: 15000,
  });

  const text = (res.data.content || []).map(b => b.text || '').join('').trim();
  return text || buildFallbackMessage(lead);
}

/**
 * Fallback template if API fails — mirrors dashboard templates.
 */
function buildFallbackMessage(lead) {
  const name = lead.name || 'your business';
  const area = lead.area || 'Singapore';
  const sub  = (lead.subcategory || '').toLowerCase();

  if (sub === 'cafe') return `Hi! Came across ${name} in ${area} and thought it was worth a quick message. I'm JJ from Stellar Kitchenware — we work with cafes across Singapore on display chillers, undercounter units, and dishwashers. Happy to share what similar setups usually need if useful!\n\nJJ from Stellar Kitchenware`;
  if (sub === 'bakery') return `Hi! Came across ${name} in ${area} and loved what you're doing. I'm JJ from Stellar Kitchenware — we specialise in cake display chillers and servicing for bakeries across Singapore. Worth a quick chat?\n\nJJ from Stellar Kitchenware`;
  if (sub === 'dessert') return `Hi! Noticed ${name} in ${area} — I'm JJ from Stellar Kitchenware. We help dessert concepts with undercounter chillers and display units. Happy to share what works for similar setups!\n\nJJ from Stellar Kitchenware`;
  if (sub === 'restaurant') return `Hi! Came across ${name} in ${area} — I'm JJ from Stellar Kitchenware. We help restaurants with prep chillers, dishwasher specs, and kitchen equipment across Singapore. Worth a quick chat?\n\nJJ from Stellar Kitchenware`;
  if (sub === 'catering') return `Hi! I'm JJ from Stellar Kitchenware. We work with catering operations on combi ovens and blast chillers — the two pieces of equipment that make the biggest difference at volume. Happy to share more if relevant!\n\nJJ from Stellar Kitchenware`;
  return `Hi! I'm JJ from Stellar Kitchenware — we supply and service commercial kitchen equipment for F&B businesses across Singapore. If you're ever reviewing suppliers or planning any kitchen changes, happy to connect!\n\nJJ from Stellar Kitchenware`;
}

module.exports = { generateOutreach };