require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const {
  getLeads, getLeadById, updateLeadStatus,
  getStats, getConversionStats, rescoreAllLeads,
  logOutreach, logReply,
  getFollowUpsDue, getRepliedNeedingNextStep, getHotNewLeads,
} = require('./db');

const { runFullScrape, scrapeCustomQuery } = require('./scraper');
const { generateOutreach }                 = require('./outreach');
const {
  sendTelegram, notifyNewLeads,
  notifyLeadReplied, recordOutreach,
  sendMorningBrief,
} = require('./notify');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Health ────────────────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({ status: 'ok', time: new Date().toISOString() })
);

// ── Stats ─────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  try { res.json(getStats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

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
      limit:    limit    ? parseInt(limit)    : 1000,
      offset:   offset   ? parseInt(offset)   : 0,
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

    if (status === 'replied') {
      const lead = getLeadById(id);
      if (lead) notifyLeadReplied(lead).catch(console.error);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Outreach log — called when user clicks Send ───────────────
app.post('/api/leads/:id/outreach-log', (req, res) => {
  try {
    const { channel, message, ab_variant } = req.body;
    const id = parseInt(req.params.id);
    if (message) logOutreach(id, channel || 'whatsapp', message, ab_variant);
    updateLeadStatus(id, 'contacted');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reply log — called when user logs a reply ─────────────────
app.post('/api/leads/:id/reply-log', (req, res) => {
  try {
    const { reply_text, next_step } = req.body;
    const id = parseInt(req.params.id);
    logReply(id, reply_text, next_step);
    updateLeadStatus(id, 'replied');
    const lead = getLeadById(id);
    if (lead) notifyLeadReplied(lead).catch(console.error);
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

// ── Rescore all leads ─────────────────────────────────────────
app.post('/api/leads/rescore', (req, res) => {
  try {
    const updated = rescoreAllLeads();
    res.json({ ok: true, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Today's work ──────────────────────────────────────────────
app.get('/api/today', (req, res) => {
  try {
    const followUps  = getFollowUpsDue();
    const needNext   = getRepliedNeedingNextStep();
    const hotLeads   = getHotNewLeads(10);
    res.json({ followUps, needNext, hotLeads });
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
    const body  = {
      api_key:                apolloKey,
      q_organization_name:    name,
      organization_locations: ['Singapore'],
      titles: [
        'owner','founder','director','operations','procurement',
        'manager','f&b manager','kitchen manager','purchasing',
      ],
      page: 1, per_page: 3,
    };
    if (website) {
      body.q_organization_domains = [
        website.replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
      ];
    }

    const result  = await axios.post('https://api.apollo.io/v1/mixed_people/search', body, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'x-api-key': apolloKey,
      },
    });

    const people = result.data.people || [];
    if (!people.length) return res.json({ found: false });

    const top = people[0];
    res.json({
      found:    true,
      name:     top.name,
      title:    top.title,
      email:    top.email,
      linkedin: top.linkedin_url,
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    res.status(500).json({
      error: typeof detail === 'string' ? detail : JSON.stringify(detail),
    });
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

    const added = result.totalAdded || result.added || 0;
    if (added > 0) {
      const newLeads = getLeads({ status: 'new', limit: added });
      await notifyNewLeads(newLeads);
    }
  } catch (err) {
    console.error('[scrape] Error:', err.message);
  }
});

// ── Crons ─────────────────────────────────────────────────────

// Daily scrape — 8am SGT
cron.schedule(process.env.SCRAPE_CRON || '0 8 * * *', async () => {
  console.log(`[cron] Scrape at ${new Date().toISOString()}`);
  try {
    const result = await runFullScrape();
    if (result.totalAdded > 0) {
      const newLeads = getLeads({ status: 'new', limit: result.totalAdded });
      await notifyNewLeads(newLeads);
    }
  } catch (err) {
    console.error('[cron] Scrape failed:', err.message);
  }
}, { timezone: 'Asia/Singapore' });

// Morning brief — 9:15am Mon–Fri
cron.schedule('15 9 * * 1-5', async () => {
  console.log(`[cron] Morning brief at ${new Date().toISOString()}`);
  try {
    const isMonday   = new Date().getDay() === 1;
    const followUps  = getFollowUpsDue();
    const needNext   = getRepliedNeedingNextStep();
    const hotLeads   = getHotNewLeads(5);
    await sendMorningBrief({ followUps, needNext, hotLeads, isMonday });
  } catch (err) {
    console.error('[cron] Morning brief failed:', err.message);
  }
}, { timezone: 'Asia/Singapore' });

// ── Start ─────────────────────────────────────────────────────
app.listen(process.env.PORT || 8080, () => {
  console.log(`
╔════════════════════════════════════╗
║   Stellar Kitchenware Lead Gen     ║
║   Port : ${process.env.PORT || 8080}                     ║
║   Cron : ${process.env.SCRAPE_CRON || '0 8 * * *'}              ║
║   Brief: 9:15am Mon-Fri SGT        ║
╚════════════════════════════════════╝`);
});

module.exports = app;