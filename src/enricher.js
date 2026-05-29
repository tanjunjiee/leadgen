const axios = require('axios');

/**
 * Scrape a website for:
 * 1. Email addresses (homepage, /contact, /about)
 * 2. Instagram handle (anywhere in page HTML)
 * 
 * Runs both in parallel per page to avoid extra round trips.
 */
async function scrapeWebsite(websiteUrl) {
  if (!websiteUrl) return { email: null, instagram: null };

  const pagesToCheck = [
    websiteUrl,
    websiteUrl.replace(/\/$/, '') + '/contact',
    websiteUrl.replace(/\/$/, '') + '/contact-us',
    websiteUrl.replace(/\/$/, '') + '/about',
  ];

  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const igRegex    = /instagram\.com\/([a-zA-Z0-9._]{2,30})\/?/i;

  const excludedEmails = [
    'example.com','sentry.io','wixpress.com','squarespace.com',
    'wordpress.com','googleapis.com','schema.org','w3.org',
    'cloudflare.com','facebook.com','twitter.com','instagram.com',
  ];

  let email     = null;
  let instagram = null;

  for (const url of pagesToCheck) {
    if (email && instagram) break; // got both, stop early
    try {
      const res = await axios.get(url, {
        timeout:      6000,
        headers:      { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' },
        maxRedirects: 3,
      });
      const html = res.data || '';

      // Extract email if not found yet
      if (!email) {
        const matches = html.match(emailRegex) || [];
        const valid   = matches.filter(e => !excludedEmails.some(ex => e.includes(ex)));
        if (valid.length > 0) email = valid[0];
      }

      // Extract Instagram handle if not found yet
      if (!instagram) {
        const igMatch = html.match(igRegex);
        if (igMatch && igMatch[1]) {
          const handle = igMatch[1].toLowerCase();
          // Filter out generic handles that aren't the business
          const skip = ['p','explore','reel','reels','stories','accounts','share'];
          if (!skip.includes(handle) && handle.length > 2) {
            instagram = handle;
          }
        }
      }
    } catch (_) {
      // page not found or timeout — try next
    }
  }

  return { email, instagram };
}

// Backwards-compatible wrapper for code still calling scrapeEmailFromWebsite
async function scrapeEmailFromWebsite(websiteUrl) {
  const { email } = await scrapeWebsite(websiteUrl);
  return email;
}

module.exports = { scrapeWebsite, scrapeEmailFromWebsite };