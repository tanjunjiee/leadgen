const axios = require('axios');

/**
 * Scrape a website for email addresses
 * Checks homepage + /contact + /about pages
 */
async function scrapeEmailFromWebsite(websiteUrl) {
  if (!websiteUrl) return null;

  const pagesToCheck = [
    websiteUrl,
    websiteUrl.replace(/\/$/, '') + '/contact',
    websiteUrl.replace(/\/$/, '') + '/contact-us',
    websiteUrl.replace(/\/$/, '') + '/about',
  ];

  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const excluded = ['example.com', 'sentry.io', 'wixpress.com', 'squarespace.com', 
                    'wordpress.com', 'googleapis.com', 'schema.org'];

  for (const url of pagesToCheck) {
    try {
      const res = await axios.get(url, {
        timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' },
        maxRedirects: 3,
      });
      const matches = res.data.match(emailRegex) || [];
      const emails = matches.filter(e => !excluded.some(ex => e.includes(ex)));
      if (emails.length > 0) return emails[0]; // return first valid email found
    } catch (e) {
      // page not found or timeout — try next
    }
  }
  return null;
}

module.exports = { scrapeEmailFromWebsite };