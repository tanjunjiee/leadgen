/**
 * Lead qualifier
 * Scores a raw Google Places result from 0–100.
 * A lead must have mobile phone OR email to qualify at all.
 * Score determines priority in the outreach queue.
 */

const SEARCH_QUERIES = [
  // F&B — direct buyers
  { query: 'cafe Singapore',                    category: 'fnb', subcategory: 'cafe' },
  { query: 'coffee shop Singapore',             category: 'fnb', subcategory: 'cafe' },
  { query: 'restaurant Singapore',              category: 'fnb', subcategory: 'restaurant' },
  { query: 'new restaurant opening Singapore',  category: 'fnb', subcategory: 'restaurant' },
  { query: 'bakery Singapore',                  category: 'fnb', subcategory: 'bakery' },
  { query: 'cake shop Singapore',               category: 'fnb', subcategory: 'bakery' },
  { query: 'bread shop Singapore',              category: 'fnb', subcategory: 'bakery' },
  { query: 'dessert shop Singapore',            category: 'fnb', subcategory: 'dessert' },
  { query: 'ice cream shop Singapore',          category: 'fnb', subcategory: 'dessert' },
  { query: 'bubble tea shop Singapore',         category: 'fnb', subcategory: 'dessert' },
  { query: 'food court stall Singapore',        category: 'fnb', subcategory: 'restaurant' },
  { query: 'catering company Singapore',        category: 'fnb', subcategory: 'restaurant' },

  // Interior designers — F&B fit-out specialists
  { query: 'interior designer commercial Singapore',  category: 'id', subcategory: 'id_firm' },
  { query: 'restaurant interior design Singapore',    category: 'id', subcategory: 'id_firm' },
  { query: 'cafe interior design firm Singapore',     category: 'id', subcategory: 'id_firm' },
  { query: 'F&B interior design Singapore',           category: 'id', subcategory: 'id_firm' },
  { query: 'commercial kitchen design Singapore',     category: 'id', subcategory: 'id_firm' },
];

/**
 * Classify a phone number for Singapore:
 * 'mobile'   — starts with 8 or 9 after +65
 * 'landline' — starts with 6 after +65
 * 'unknown'  — no number or unrecognised format
 */
function classifyPhone(place) {
  const raw = place.international_phone_number || place.formatted_phone_number || '';
  const digits = raw.replace(/\D/g, '');

  if (/^658[0-9]{7}$/.test(digits)) return 'mobile';
  if (/^659[0-9]{7}$/.test(digits)) return 'mobile';
  if (/^656[0-9]{7}$/.test(digits)) return 'landline';
  if (/^[89][0-9]{7}$/.test(digits)) return 'mobile';
  if (/^6[0-9]{7}$/.test(digits))   return 'landline';

  return digits.length > 0 ? 'landline' : 'unknown';
}

function scoreLead(place, subcategory) {
  const phoneType   = classifyPhone(place);
  const hasMobile   = phoneType === 'mobile';
  const hasLandline = phoneType === 'landline';
  const hasEmail    = extractEmail(place);

  if (!hasMobile && !hasEmail) {
    const reason = hasLandline ? 'Landline only — no direct contact' : 'No contact info';
    return { score: 0, disqualified: true, reason };
  }

  if (place.business_status === 'CLOSED_PERMANENTLY') {
    return { score: 0, disqualified: true, reason: 'Permanently closed' };
  }

  let score = 0;

  if (hasMobile)        score += 25;
  else if (hasLandline) score += 10;
  if (hasEmail)         score += 15;

  if (place.business_status === 'OPERATIONAL') score += 15;
  if (place.opening_hours?.open_now)           score += 5;
  if (place.website)                           score += 10;

  const rating      = place.rating || 0;
  const reviewCount = place.user_ratings_total || 0;
  if (rating >= 4.0)       score += 10;
  else if (rating >= 3.5)  score += 5;
  if (reviewCount >= 50)   score += 10;
  else if (reviewCount >= 20) score += 5;

  // Bonus: having reviews means we can AI-personalise outreach
  if (place.reviews && place.reviews.length > 0) score += 5;

  if (['bakery', 'dessert'].includes(subcategory)) score += 10;
  else if (subcategory === 'id_firm')              score += 8;
  else                                             score += 5;

  return { score: Math.min(score, 100), disqualified: false, reason: null };
}

function extractEmail(place) {
  return place.email || null;
}

/**
 * Pull the most useful snippets from Google reviews.
 * We keep up to 4 reviews, max 300 chars each, to avoid bloating the DB.
 * These are passed to Claude in the dashboard to generate personalised openers.
 */
function extractReviewSnippets(place) {
  if (!place.reviews || place.reviews.length === 0) return [];
  return place.reviews
    .filter(r => r.text && r.text.trim().length > 20)
    .slice(0, 4)
    .map(r => ({
      rating: r.rating,
      text: r.text.trim().slice(0, 300),
      time: r.relative_time_description || '',
    }));
}

function normaliseLead(place, category, subcategory) {
  const { score, disqualified, reason } = scoreLead(place, subcategory);
  const phoneType = classifyPhone(place);
  const area = extractArea(place.formatted_address || '');

  return {
    name:             place.name,
    address:          place.formatted_address || '',
    area,
    category,
    subcategory,
    phone:            place.international_phone_number || place.formatted_phone_number || '',
    phone_type:       phoneType,
    email:            extractEmail(place) || '',
    website:          place.website || '',
    google_place_id:  place.place_id,
    rating:           place.rating || null,
    review_count:     place.user_ratings_total || 0,
    // Review snippets stored as JSON — used by dashboard for AI outreach generation
    review_snippets:  extractReviewSnippets(place),
    // Google's own editorial summary if present
    editorial_summary: place.editorial_summary?.overview || '',
    score,
    _disqualified:    disqualified,
    _reason:          reason,
  };
}

function extractArea(address) {
  const parts = address.split(',').map(s => s.trim());
  const sgIndex = parts.findIndex(p => p.toLowerCase().startsWith('singapore'));
  if (sgIndex > 1) return parts[sgIndex - 1];
  if (parts.length >= 2) return parts[parts.length - 2];
  return 'Singapore';
}

module.exports = { SEARCH_QUERIES, scoreLead, normaliseLead, classifyPhone };