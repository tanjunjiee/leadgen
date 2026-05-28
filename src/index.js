require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { getLeads, updateLeadStatus, getStats } = require('./db');
const { runFullScrape, scrapeCustomQuery } = require('./scraper');
const { generateOutreach } = require('./outreach');
const { sendApprovalRequest, notifyNewLeads, notifyLeadReplied, recordOutreach } = require('./notify');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Health check ──────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Stats ─────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  try {
    res.json(getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Leads ─────────────────────────────────────────────────────

app.get('/api/leads', (req, res) => {
  try {
    const { status, category, minScore, limit, offset } = req.query;
    const leads = getLeads({
      status,
      category,
      minScore: minScore ? parseInt(minScore) : undefined,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
    });
    const mapped = leads.map(l => ({
      ...l,
      type: l.category === 'fnb' ? 'F&B' : l.category === 'id' ? 'Interior' : 'Other',
    }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/leads/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['new', 'contacted', 'replied', 'qualified', 'dead'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    updateLeadStatus(parseInt(req.params.id), status);

    // If marked replied, send Telegram notification
    if (status === 'replied') {
      const leads = getLeads({ limit: 1 });
      const lead = leads.find(l => l.id === parseInt(req.params.id));
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
    const leads = getLeads({ limit: 1000 });
    const lead = leads.find(l => l.id === parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const channel = req.body.channel || 'whatsapp';
    const message = await generateOutreach(lead, channel);
    res.json({ message, channel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send outreach (with approval step)
app.post('/api/leads/:id/send', async (req, res) => {
  try {
    const leads = getLeads({ limit: 1000 });
    const lead = leads.find(l => l.id === parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const { message, channel } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // Log outreach + mark contacted
    await recordOutreach(lead.id, channel, message, true);

    // Send approval request to your WhatsApp (human-in-the-loop)
    await sendApprovalRequest(lead, message, channel);

    res.json({ ok: true, message: 'Sent for your approval via WhatsApp' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Scraping ──────────────────────────────────────────────────

app.post('/api/scrape', async (req, res) => {
  const { query, category } = req.body;

  // Respond immediately, run in background
  res.json({ ok: true, message: 'Scrape started' });

  try {
    let result;
    if (query) {
      result = await scrapeCustomQuery(query, category || 'fnb');
    } else {
      result = await runFullScrape();
    }

    // Notify via Telegram if new leads found
    if (result.totalAdded > 0) {
      const newLeads = getLeads({ status: 'new', limit: result.totalAdded });
      await notifyNewLeads(newLeads);
    }
  } catch (err) {
    console.error('[scrape] Error:', err.message);
  }
});

// ── Cron job — runs daily at 8am Singapore time ───────────────

const SCRAPE_CRON = process.env.SCRAPE_CRON || '0 8 * * *';

cron.schedule(SCRAPE_CRON, async () => {
  console.log(`[cron] Running scheduled scrape at ${new Date().toISOString()}`);
  try {
    const result = await runFullScrape();
    if (result.totalAdded > 0) {
      const newLeads = getLeads({ status: 'new', limit: result.totalAdded });
      await notifyNewLeads(newLeads);
    }
  } catch (err) {
    console.error('[cron] Scrape failed:', err.message);
  }
}, {
  timezone: 'Asia/Singapore',
});

// ── Start server ──────────────────────────────────────────────

app.listen(process.env.PORT || 8080, () => {
  console.log(`
╔════════════════════════════════════╗
║   Kitchenware Lead Generator       ║
║   Running on port ${process.env.PORT || 8080}             ║
║   Scrape cron: ${process.env.SCRAPE_CRON}       ║
╚════════════════════════════════════╝
  `);
});

module.exports = app;
