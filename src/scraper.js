require('dotenv').config();
const axios  = require('axios');
const { upsertLead, logScrape, getLeads } = require('./db');
const { SEARCH_QUERIES, normaliseLead, isKnownChain } = require('./qualifier');
const { scrapeWebsite } = require('./enricher');

const PLACES_BASE       = 'https://maps.googleapis.com/maps/api/place';
const API_KEY           = process.env.GOOGLE_MAPS_API_KEY;
const SINGAPORE_LOCATION = '1.3521,103.8198';
const RADIUS_METERS     = 25000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Chain consolidation ───────────────────────────────────────
/**
 * Derive a canonical brand name from a business name.
 * Strategy: lowercase, strip punctuation, take the first 2-3 meaningful words.
 * When the same canonical name appears 2+ times in the DB, it's a chain.
 * 
 * Examples:
 *   "Playmade By Each A Cup (Tampines)" → "playmade"
 *   "KOI Café @ Jurong Point"           → "koi cafe"
 *   "Starbucks Coffee - VivoCity"       → "starbucks coffee"
 */
function deriveCanonicalName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')  // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 2)                   // first 2 words = brand identity
    .join(' ');
}

/**
 * Given a list of leads sharing the same canonical name,
 * pick the best contact (ranked: mobile > email > landline).
 * Returns { best_phone, best_email, all_phones, all_emails }
 */
function consolidateContacts(leads) {
  const phones = leads
    .map(l => ({ phone: l.phone, type: l.phone_type, name: l.name }))
    .filter(p => p.phone);
  const emails = leads
    .map(l => ({ email: l.email, name: l.name }))
    .filter(e => e.email);

  // Sort phones: mobile first
  phones.sort((a, b) => {
    if (a.type === 'mobile' && b.type !== 'mobile') return -1;
    if (b.type === 'mobile' && a.type !== 'mobile') return  1;
    return 0;
  });

  return {
    best_phone:  phones[0]?.phone  || null,
    best_email:  emails[0]?.email  || null,
    all_phones:  phones,
    all_emails:  emails,
    outlet_count: leads.length,
  };
}

// ── Google Places API ─────────────────────────────────────────
async function textSearch(query, pageToken = null) {
  const params = {
    query,
    location: SINGAPORE_LOCATION,
    radius:   RADIUS_METERS,
    key:      API_KEY,
    region:   'sg',
  };
  if (pageToken) params.pagetoken = pageToken;

  const res  = await axios.get(`${PLACES_BASE}/textsearch/json`, { params });
  const data = res.data;

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Places API error: ${data.status} — ${data.error_message || ''}`);
  }

  return {
    places:        data.results || [],
    nextPageToken: data.next_page_token || null,
  };
}

async function getPlaceDetails(placeId) {
  const fields = [
    'name', 'place_id', 'formatted_address',
    'formatted_phone_number', 'international_phone_number',
    'website', 'business_status', 'opening_hours',
    'rating', 'user_ratings_total',
    'reviews',           // for AI personalisation + signal detection
    'editorial_summary', // Google's own summary
  ].join(',');

  const res = await axios.get(`${PLACES_BASE}/details/json`, {
    params: { place_id: placeId, fields, key: API_KEY },
  });

  if (res.data.status !== 'OK') {
    throw new Error(`Place details error: ${res.data.status}`);
  }

  return res.data.result;
}

// ── Scrape a single query ─────────────────────────────────────
async function scrapeQuery({ query, category, subcategory }, maxPages = 2) {
  console.log(`[scraper] "${query}"`);
  let found = 0, added = 0, updated = 0, skipped = 0;
  let pageToken = null;
  let page      = 0;

  do {
    if (pageToken) await sleep(2000);
    const { places, nextPageToken } = await textSearch(query, pageToken);
    pageToken = nextPageToken;
    found += places.length;

    for (const place of places) {
      try {
        const details = await getPlaceDetails(place.place_id);
        await sleep(100);

        // Enrich with email + Instagram from website
        if (details.website) {
          const enriched = await scrapeWebsite(details.website);
          if (enriched.email    && !details.email)    details.email    = enriched.email;
          if (enriched.instagram && !details.instagram) details.instagram = enriched.instagram;
        }

        // Determine if chain via known list or canonical name frequency
        const canonical = deriveCanonicalName(details.name);
        const isChain   = isKnownChain(details.name);

        const lead = normaliseLead(details, category, subcategory, {
          is_chain:       isChain,
          canonical_name: canonical,
        });

        if (lead._disqualified) {
          skipped++;
          console.log(`  ✗ ${lead.name} — ${lead._reason}`);
          continue;
        }

        const { isNew } = upsertLead(lead);
        if (isNew) {
          added++;
          console.log(`  ✓ ${lead.name} (${lead.area}) score=${lead.score}${lead.instagram ? ' ig=@' + lead.instagram : ''}`);
        } else {
          updated++;
        }
      } catch (err) {
        console.error(`  ! ${place.name}: ${err.message}`);
        skipped++;
      }
    }
    page++;
  } while (pageToken && page < maxPages);

  logScrape(query, found, added);
  return { found, added, updated, skipped };
}

// ── Post-scrape chain consolidation ──────────────────────────
/**
 * After each full scrape, scan the DB for canonical names that appear
 * 2+ times. Mark all of them as chains, consolidate contacts,
 * and update the is_chain flag so scoring reflects reality.
 */
async function consolidateChains(db) {
  const allLeads = db.prepare(`
    SELECT id, name, phone, phone_type, email, canonical_name, is_chain
    FROM leads
    WHERE canonical_name IS NOT NULL AND canonical_name != ''
  `).all();

  // Group by canonical name
  const groups = {};
  for (const lead of allLeads) {
    const key = lead.canonical_name;
    if (!groups[key]) groups[key] = [];
    groups[key].push(lead);
  }

  let consolidated = 0;
  for (const [canonical, leads] of Object.entries(groups)) {
    if (leads.length < 2) continue; // not a chain

    const contacts = consolidateContacts(leads);

    // Update all outlets in this group
    for (const lead of leads) {
      db.prepare(`
        UPDATE leads SET
          is_chain        = 1,
          chain_size      = @chain_size,
          best_dm_phone   = @best_phone,
          best_dm_email   = @best_email,
          all_chain_contacts = @all_contacts,
          updated_at      = datetime('now')
        WHERE id = @id
      `).run({
        id:           lead.id,
        chain_size:   contacts.outlet_count,
        best_phone:   contacts.best_phone,
        best_email:   contacts.best_email,
        all_contacts: JSON.stringify({
          phones: contacts.all_phones,
          emails: contacts.all_emails,
        }),
      });
    }
    consolidated++;
    console.log(`[chain] "${canonical}" — ${leads.length} outlets consolidated`);
  }

  console.log(`[chain] Consolidated ${consolidated} brand groups`);
  return consolidated;
}

// ── Full scrape ───────────────────────────────────────────────
async function runFullScrape() {
  if (!API_KEY || API_KEY === 'your_google_maps_api_key_here') {
    console.error('[scraper] ERROR: GOOGLE_MAPS_API_KEY not set');
    return { error: 'API key not configured' };
  }

  console.log(`[scraper] Starting — ${SEARCH_QUERIES.length} queries`);
  const start = Date.now();
  let totalFound = 0, totalAdded = 0, totalUpdated = 0;

  for (const queryConfig of SEARCH_QUERIES) {
    try {
      const { found, added, updated } = await scrapeQuery(queryConfig);
      totalFound   += found;
      totalAdded   += added;
      totalUpdated += updated;
      await sleep(500);
    } catch (err) {
      console.error(`[scraper] Query failed: ${queryConfig.query} — ${err.message}`);
    }
  }

  // Run chain consolidation after every full scrape
  try {
    const { getDb } = require('./db');
    await consolidateChains(getDb());
  } catch (err) {
    console.error('[scraper] Chain consolidation error:', err.message);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[scraper] Done in ${elapsed}s — ${totalFound} found, ${totalAdded} new, ${totalUpdated} updated`);
  return { totalFound, totalAdded, totalUpdated, elapsed };
}

async function scrapeCustomQuery(query, category = 'fnb') {
  return scrapeQuery({
    query,
    category,
    subcategory: category === 'id' ? 'id_firm' : 'restaurant',
  });
}

module.exports = { runFullScrape, scrapeCustomQuery, consolidateChains };

if (require.main === module) {
  runFullScrape().then(r => { console.log('Result:', r); process.exit(0); })
    .catch(err => { console.error(err); process.exit(1); });
}