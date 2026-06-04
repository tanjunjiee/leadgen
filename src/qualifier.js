/**
 * Lead qualifier — v2
 * 
 * Scoring philosophy:
 * - Contact quality (40pts): can we actually reach a decision maker?
 * - Business quality (35pts): is this a real, active, established business?
 * - Intent multiplier (25pts): do they have a reason to buy now?
 * - Chain penalty (×0.5): chains are hard to reach — penalise until HQ contact confirmed
 * - Solo bonus (+5): owner-operated = fastest path to a decision
 * 
 * Score meaning:
 * 80-100 = Hot. Solo/mid business, reachable, active signal. Contact today.
 * 60-79  = Warm. Good business, reachable, no signal yet.
 * 40-59  = Medium. Chain, or medium contact quality, or no signals.
 * <40    = Cold. Chain with no HQ contact, or weak all round.
 */

const SEARCH_QUERIES = [
  { query: 'cafe Singapore',                           category: 'fnb', subcategory: 'cafe' },
  { query: 'coffee shop Singapore',                    category: 'fnb', subcategory: 'cafe' },
  { query: 'restaurant Singapore',                     category: 'fnb', subcategory: 'restaurant' },
  { query: 'new restaurant opening Singapore',         category: 'fnb', subcategory: 'restaurant' },
  { query: 'bakery Singapore',                         category: 'fnb', subcategory: 'bakery' },
  { query: 'cake shop Singapore',                      category: 'fnb', subcategory: 'bakery' },
  { query: 'bread shop Singapore',                     category: 'fnb', subcategory: 'bakery' },
  { query: 'dessert shop Singapore',                   category: 'fnb', subcategory: 'dessert' },
  { query: 'ice cream shop Singapore',                 category: 'fnb', subcategory: 'dessert' },
  { query: 'bubble tea shop Singapore',                category: 'fnb', subcategory: 'dessert' },
  { query: 'food court stall Singapore',               category: 'fnb', subcategory: 'restaurant' },
  { query: 'catering company Singapore',               category: 'fnb', subcategory: 'catering' },
  { query: 'interior designer commercial Singapore',   category: 'id',  subcategory: 'id_firm' },
  { query: 'restaurant interior design Singapore',     category: 'id',  subcategory: 'id_firm' },
  { query: 'cafe interior design firm Singapore',      category: 'id',  subcategory: 'id_firm' },
  { query: 'F&B interior design Singapore',            category: 'id',  subcategory: 'id_firm' },
  { query: 'commercial kitchen design Singapore',      category: 'id',  subcategory: 'id_firm' },
];

// ── A/B variant assignment ────────────────────────────────────
// Assigned at scrape time, stored on the lead.
// A = observation + specific problem hook
// B = direct question + binary choice hook
function assignVariant() {
  const variants = ['A', 'B', 'C', 'D'];
  return variants[Math.floor(Math.random() * 4)];
}

// ── Phone classification ──────────────────────────────────────
function classifyPhone(place) {
  const raw    = place.international_phone_number || place.formatted_phone_number || '';
  const digits = raw.replace(/\D/g, '');
  if (/^658[0-9]{7}$/.test(digits) || /^659[0-9]{7}$/.test(digits)) return 'mobile';
  if (/^[89][0-9]{7}$/.test(digits)) return 'mobile';
  if (/^656[0-9]{7}$/.test(digits) || /^6[0-9]{7}$/.test(digits))  return 'landline';
  return digits.length > 0 ? 'landline' : 'unknown';
}

// ── Chain detection ───────────────────────────────────────────
// If the same canonical brand name appears 2+ times in the DB,
// it gets flagged as a chain during consolidation in the scraper.
// Here we do a lighter check based on known chain patterns.
const KNOWN_CHAINS = [
  'playmade','koi','gong cha','tiger sugar','heytea','liho','share tea',
  'bengawan solo','breadtalk','four leaves','toast box','yakun','ya kun',
  'mcdonalds','kfc','subway','starbucks','coffee bean','old chang kee',
  'mr bean','polar','paris baguette','swensens','crystal jade','din tai fung',
  'paradise','imperial treasure','jumbo','burger king','jollibee',
  'hokkaido baked','auntie anne','beard papa','ichiban','sushi tei',
  'sakae','genki','llaollao','tealive','wingstop','texas chicken',
  'old town','gloria jeans','the coffee bean','dome','toastbox',
  'super tea','chicha san chen','machi machi','7 leaves','each a cup',
];

function isKnownChain(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return KNOWN_CHAINS.some(c => n.includes(c));
}

// ── Scoring ───────────────────────────────────────────────────
function scoreLead(place, subcategory, isChain = false) {
  const phoneType   = classifyPhone(place);
  const hasMobile   = phoneType === 'mobile';
  const hasLandline = phoneType === 'landline';
  const hasEmail    = !!(place.email);
  const chain       = isChain || isKnownChain(place.name);

  // Hard disqualifiers
  if (place.business_status === 'CLOSED_PERMANENTLY') {
    return { score: 0, disqualified: true, reason: 'Permanently closed' };
  }
  if (!hasMobile && !hasEmail) {
    const reason = hasLandline ? 'Landline only — no direct contact' : 'No contact info';
    return { score: 0, disqualified: true, reason };
  }

  // ── Dimension 1: Contact quality (40pts max) ──────────────
  let contactScore = 0;
  if (chain) {
    // Chains: cap contact score regardless of phone type
    // until HQ contact is confirmed
    contactScore = 15;
  } else if (hasMobile) {
    contactScore = 40;
  } else if (hasEmail) {
    contactScore = 25;
  }

  // ── Dimension 2: Business quality (35pts max) ─────────────
  let bizScore = 0;
  if (place.business_status === 'OPERATIONAL') bizScore += 10;
  if (place.website)                           bizScore += 8;

  const rating = place.rating || 0;
  if      (rating >= 4.5) bizScore += 10;
  else if (rating >= 4.0) bizScore += 7;
  else if (rating >= 3.5) bizScore += 4;

  const rc = place.user_ratings_total || 0;
  if      (rc >= 300) bizScore += 3;  // diminishing — high count = likely chain
  else if (rc >= 150) bizScore += 7;
  else if (rc >= 50)  bizScore += 5;
  else if (rc >= 20)  bizScore += 3;

  if (place.editorial_summary?.overview) bizScore += 2;
  if (place.reviews && place.reviews.length > 0) bizScore += 3;

  bizScore = Math.min(bizScore, 35);

  // ── Dimension 3: Purchase intent (25pts max) ──────────────
  // Keyword pre-filter only — AI analysis adds more later.
  // Only equipment-solvable signals counted here.
  let intentScore = 0;
  const reviewText = (place.reviews || []).map(r => r.text || '').join(' ').toLowerCase();
  const summaryText = (place.editorial_summary?.overview || '').toLowerCase();
  const scanText = reviewText + ' ' + summaryText;

  // Equipment failure signals (highest value — immediate need)
  if (/chiller broke|fridge broke|freezer broke|equipment down|machine broken|not cold enough|drinks not cold|ice cream melt|no ice|dirty (plates|cups|glasses|cutlery)/.test(scanText)) {
    intentScore += 25;
  }
  // Expansion signals (new kitchen needed)
  else if (/opening soon|new outlet|new branch|second outlet|central kitchen|commissary/.test(scanText)) {
    intentScore += 20;
  }
  // Renovation signals (refit opportunity)
  else if (/closed for reno|closed for renovation|reopening|new interior|after reno/.test(scanText)) {
    intentScore += 18;
  }

  intentScore = Math.min(intentScore, 25);

  // ── Combine ───────────────────────────────────────────────
  let total = contactScore + bizScore + intentScore;

  // Chain penalty — halve the score until HQ contact confirmed
  if (chain) total = Math.round(total * 0.5);

  // Solo owner bonus — fastest path to a decision
  const isSolo = !chain && rc < 80 && hasMobile;
  if (isSolo) total += 5;

  // ID firms: different scoring — partnership value, not equipment urgency
  if (subcategory === 'id_firm') {
    total = contactScore + bizScore + 5; // no intent bonus, flat partnership signal
    if (hasMobile && hasEmail) total += 5; // bonus for dual contact
  }

  return {
    score:        Math.min(Math.max(total, 0), 100),
    disqualified: false,
    reason:       null,
    is_chain:     chain,
    is_solo:      isSolo,
  };
}

function extractEmail(place) {
  return place.email || null;
}

function extractReviewSnippets(place) {
  if (!place.reviews || place.reviews.length === 0) return [];
  return place.reviews
    .filter(r => r.text && r.text.trim().length > 20)
    .slice(0, 4)
    .map(r => ({
      rating: r.rating,
      text:   r.text.trim().slice(0, 300),
      time:   r.relative_time_description || '',
    }));
}

function normaliseLead(place, category, subcategory, overrides = {}) {
  const isChain  = overrides.is_chain || false;
  const { score, disqualified, reason, is_chain, is_solo } = scoreLead(place, subcategory, isChain);
  const phoneType = classifyPhone(place);
  const area      = extractArea(place.formatted_address || '');

  return {
    name:              place.name,
    address:           place.formatted_address || '',
    area,
    category,
    subcategory,
    phone:             place.international_phone_number || place.formatted_phone_number || '',
    phone_type:        phoneType,
    email:             extractEmail(place) || '',
    website:           place.website || '',
    instagram:         place.instagram || '',      // set by enricher
    google_place_id:   place.place_id,
    rating:            place.rating || null,
    review_count:      place.user_ratings_total || 0,
    review_snippets:   extractReviewSnippets(place),
    editorial_summary: place.editorial_summary?.overview || '',
    score,
    is_chain:          is_chain ? 1 : 0,
    is_solo:           is_solo  ? 1 : 0,
    canonical_name:    overrides.canonical_name || null,  // set by scraper on consolidation
    ab_variant:        assignVariant(),
    _disqualified:     disqualified,
    _reason:           reason,
  };
}

function extractArea(address) {
  const parts    = address.split(',').map(s => s.trim());
  const sgIndex  = parts.findIndex(p => p.toLowerCase().startsWith('singapore'));
  if (sgIndex > 1)        return parts[sgIndex - 1];
  if (parts.length >= 2)  return parts[parts.length - 2];
  return 'Singapore';
}

module.exports = { SEARCH_QUERIES, scoreLead, normaliseLead, classifyPhone, isKnownChain, assignVariant };