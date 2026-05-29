require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const { getLeads, getLeadById, updateLeadStatus, getStats, getConversionStats } = require('./db');
const { runFullScrape, scrapeCustomQuery } = require('./scraper');
const { generateOutreach } = require('./outreach');
const { sendApprovalRequest, notifyNewLeads, notifyLeadReplied, recordOutreach } = require('./notify');

const app  = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Health ────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Stats ─────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  try { res.json(getStats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Conversion stats — feedback loop data
app.get('/api/stats/conversions', (req, res) => {
  try { res.json(getConversionStats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Leads ─────────────────────────────────────────────────────
app.get('/api/leads', (req, res) => {
  try {
    const { status, category, minScore, limit, offset } = req.query;
    const leads = getLeads({
      status,
      category,
      minScore: minScore ? parseInt(minScore) : undefined,
      limit:    limit  ? parseInt(limit)  : 1000,
      offset:   offset ? parseInt(offset) : 0,
    });
    res.json(leads.map(l => ({
      ...l,
      type: l.category === 'fnb' ? 'F&B' : l.category === 'id' ? 'Interior' : 'Other',
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/leads/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['new','contacted','replied','meeting','qualified','closed','dead'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const id = parseInt(req.params.id);
    updateLeadStatus(id, status);

    // Notify on reply
    if (status === 'replied') {
      const lead = getLeadById(id);
      if (lead) notifyLeadReplied(lead).catch(console.error);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Outreach generation ───────────────────────────────────────
app.post('/api/leads/:id/outreach', async (req, res) => {
  try {
    const lead = getLeadById(parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const message = await generateOutreach(lead, req.body.channel || 'whatsapp');
    res.json({ message, channel: req.body.channel || 'whatsapp' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads/:id/send', async (req, res) => {
  try {
    const lead = getLeadById(parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const { message, channel } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    await recordOutreach(lead.id, channel, message, true);
    await sendApprovalRequest(lead, message, channel);
    res.json({ ok: true, message: 'Sent for your approval via WhatsApp' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Apollo DM lookup ──────────────────────────────────────────
app.post('/api/apollo/lookup', async (req, res) => {
  const apolloKey = process.env.APOLLO_API_KEY;
  if (!apolloKey) return res.status(500).json({ error: 'APOLLO_API_KEY not set' });

  const { name, website } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const axios = require('axios');
    const body = {
      api_key: apolloKey,
      q_organization_name: name,
      organization_locations: ['Singapore'],
      titles: ['owner','founder','director','operations','procurement','manager','f&b manager','kitchen manager','purchasing'],
      page: 1, per_page: 3,
    };
    if (website) body.q_organization_domains = [website.replace(/^https?:\/\//, '').replace(/\/.*$/, '')];

    const result = await axios.post('https://api.apollo.io/v1/mixed_people/search', body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
    });

    const people = result.data.people || [];
    if (!people.length) return res.json({ found: false });
    const top = people[0];
    res.json({ found: true, name: top.name, title: top.title, email: top.email, linkedin: top.linkedin_url });
  } catch (err) {
    const detail = err.response?.data || err.message;
    res.status(500).json({ error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

// ── Scraping ──────────────────────────────────────────────────
app.post('/api/scrape', async (req, res) => {
  const { query, category } = req.body;
  res.json({ ok: true, message: 'Scrape started' });
  try {
    const result = query
      ? await scrapeCustomQuery(query, category || 'fnb')
      : await runFullScrape();
    if ((result.totalAdded || result.added) > 0) {
      const newLeads = getLeads({ status: 'new', limit: result.totalAdded || result.added });
      await notifyNewLeads(newLeads);
    }
  } catch (err) {
    console.error('[scrape] Error:', err.message);
  }
});

// ── Cron — daily 8am SGT ──────────────────────────────────────
cron.schedule(process.env.SCRAPE_CRON || '0 8 * * *', async () => {
  console.log(`[cron] Scheduled scrape at ${new Date().toISOString()}`);
  try {
    const result = await runFullScrape();
    if (result.totalAdded > 0) {
      const newLeads = getLeads({ status: 'new', limit: result.totalAdded });
      await notifyNewLeads(newLeads);
    }
  } catch (err) {
    console.error('[cron] Failed:', err.message);
  }
}, { timezone: 'Asia/Singapore' });

// ── Start ─────────────────────────────────────────────────────
app.listen(process.env.PORT || 8080, () => {
  console.log(`
╔════════════════════════════════════╗
║   Stellar Kitchenware Lead Gen     ║
║   Port: ${process.env.PORT || 8080}                      ║
║   Cron: ${process.env.SCRAPE_CRON || '0 8 * * *'}               ║
╚════════════════════════════════════╝`);
});

module.exports = app;