require('dotenv').config();
const axios = require('axios');
const { upsertLead, logScrape } = require('./db');
const { SEARCH_QUERIES, normaliseLead } = require('./qualifier');
const { scrapeEmailFromWebsite } = require('./enricher');

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Singapore bounding box — keeps results local
const SINGAPORE_LOCATION = '1.3521,103.8198';
const RADIUS_METERS = 25000; // covers most of Singapore island

/**
 * Text search for a single query, returns array of place IDs
 */
async function textSearch(query, pageToken = null) {
  const params = {
    query,
    location: SINGAPORE_LOCATION,
    radius: RADIUS_METERS,
    key: API_KEY,
    region: 'sg',
  };
  if (pageToken) params.pagetoken = pageToken;

  const res = await axios.get(`${PLACES_BASE}/textsearch/json`, { params });
  const data = res.data;

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Places API error: ${data.status} — ${data.error_message || ''}`);
  }

  return {
    places: data.results || [],
    nextPageToken: data.next_page_token || null,
  };
}

/**
 * Get full details for a place ID
 * We request only the fields we need to minimise cost
 */
async function getPlaceDetails(placeId) {
  const fields = [
    'name',
    'place_id',
    'formatted_address',
    'formatted_phone_number',
    'international_phone_number',
    'website',
    'business_status',
    'opening_hours',
    'rating',
    'user_ratings_total',
  ].join(',');

  const res = await axios.get(`${PLACES_BASE}/details/json`, {
    params: { place_id: placeId, fields, key: API_KEY },
  });

  if (res.data.status !== 'OK') {
    throw new Error(`Place details error: ${res.data.status}`);
  }

  return res.data.result;
}

/**
 * Sleep helper — Google requires a short delay between paginated requests
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Scrape a single query, up to maxPages pages (each page = 20 results)
 * Returns { found, added, skipped }
 */
async function scrapeQuery({ query, category, subcategory }, maxPages = 2) {
  console.log(`[scraper] Searching: "${query}"`);
  let found = 0, added = 0, skipped = 0;
  let pageToken = null;
  let page = 0;

  do {
    if (pageToken) await sleep(2000); // Google requires 2s between paginated requests

    const { places, nextPageToken } = await textSearch(query, pageToken);
    pageToken = nextPageToken;
    found += places.length;

    for (const place of places) {
      try {
        // Get full details (phone, website, hours)
        const details = await getPlaceDetails(place.place_id);
        await sleep(100); // be polite to the API

        // Enrich with email from website
        if (details.website && !details.email) {
          details.email = await scrapeEmailFromWebsite(details.website);
        }

        const lead = normaliseLead(details, category, subcategory);

        if (lead._disqualified) {
          skipped++;
          console.log(`  ✗ ${lead.name} — ${lead._reason}`);
          continue;
        }

        const { isNew } = upsertLead(lead);
        if (isNew) {
          added++;
          console.log(`  ✓ ${lead.name} (${lead.area}) score=${lead.score}`);
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(`  ! Error processing ${place.name}: ${err.message}`);
        skipped++;
      }
    }

    page++;
  } while (pageToken && page < maxPages);

  logScrape(query, found, added);
  return { found, added, skipped };
}

/**
 * Run all queries — called by the cron job
 */
async function runFullScrape() {
  if (!API_KEY || API_KEY === 'your_google_maps_api_key_here') {
    console.error('[scraper] ERROR: GOOGLE_MAPS_API_KEY not set in .env');
    return { error: 'API key not configured' };
  }

  console.log(`[scraper] Starting full scrape — ${SEARCH_QUERIES.length} queries`);
  const start = Date.now();
  let totalFound = 0, totalAdded = 0;

  for (const queryConfig of SEARCH_QUERIES) {
    try {
      const { found, added } = await scrapeQuery(queryConfig);
      totalFound += found;
      totalAdded += added;
      await sleep(500); // pause between queries
    } catch (err) {
      console.error(`[scraper] Query failed: ${queryConfig.query} — ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[scraper] Done in ${elapsed}s — ${totalFound} found, ${totalAdded} new leads`);
  return { totalFound, totalAdded, elapsed };
}

/**
 * Scrape a single custom query — called from the dashboard "Find new leads" button
 */
async function scrapeCustomQuery(query, category = 'fnb') {
  return scrapeQuery({ query, category, subcategory: category === 'id' ? 'id_firm' : 'restaurant' });
}

module.exports = { runFullScrape, scrapeCustomQuery };

// Run directly: node src/scraper.js
if (require.main === module) {
  runFullScrape().then(result => {
    console.log('Result:', result);
    process.exit(0);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}