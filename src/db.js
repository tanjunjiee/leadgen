const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/leads.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      address     TEXT,
      area        TEXT,
      category    TEXT NOT NULL,  -- 'fnb' or 'id'
      subcategory TEXT,           -- 'cafe','restaurant','bakery','dessert','id_firm'
      phone       TEXT,
      email       TEXT,
      website     TEXT,
      google_place_id TEXT UNIQUE,
      rating      REAL,
      review_count INTEGER,
      score       INTEGER DEFAULT 0,
      status      TEXT DEFAULT 'new',  -- new/contacted/replied/qualified/dead
      outreach_channel TEXT,           -- whatsapp/email
      last_contacted_at TEXT,
      notes       TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS outreach_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id    INTEGER NOT NULL,
      channel    TEXT NOT NULL,
      message    TEXT NOT NULL,
      sent_at    TEXT DEFAULT (datetime('now')),
      approved   INTEGER DEFAULT 0,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );

    CREATE TABLE IF NOT EXISTS scrape_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      query      TEXT,
      results    INTEGER DEFAULT 0,
      new_leads  INTEGER DEFAULT 0,
      ran_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_category ON leads(category);
    CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score DESC);
  `);
}

// ── Lead queries ──────────────────────────────────────────────

function upsertLead(lead) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM leads WHERE google_place_id = ?').get(lead.google_place_id);
  if (existing) return { id: existing.id, isNew: false };

  const result = db.prepare(`
    INSERT INTO leads (name, address, area, category, subcategory, phone, email, website, google_place_id, rating, review_count, score)
    VALUES (@name, @address, @area, @category, @subcategory, @phone, @email, @website, @google_place_id, @rating, @review_count, @score)
  `).run(lead);

  return { id: result.lastInsertRowid, isNew: true };
}

function getLeads({ status, category, minScore, limit = 100, offset = 0 } = {}) {
  const db = getDb();
  let query = 'SELECT * FROM leads WHERE 1=1';
  const params = [];
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  if (minScore) { query += ' AND score >= ?'; params.push(minScore); }
  query += ' ORDER BY score DESC, created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(query).all(...params);
}

function updateLeadStatus(id, status) {
  getDb().prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

function logOutreach(leadId, channel, message) {
  return getDb().prepare('INSERT INTO outreach_log (lead_id, channel, message) VALUES (?, ?, ?)').run(leadId, channel, message);
}

function logScrape(query, results, newLeads) {
  getDb().prepare('INSERT INTO scrape_log (query, results, new_leads) VALUES (?, ?, ?)').run(query, results, newLeads);
}

function getStats() {
  const db = getDb();
  return {
    total:     db.prepare("SELECT COUNT(*) as n FROM leads").get().n,
    new:       db.prepare("SELECT COUNT(*) as n FROM leads WHERE status='new'").get().n,
    contacted: db.prepare("SELECT COUNT(*) as n FROM leads WHERE status='contacted'").get().n,
    replied:   db.prepare("SELECT COUNT(*) as n FROM leads WHERE status='replied'").get().n,
    qualified: db.prepare("SELECT COUNT(*) as n FROM leads WHERE status='qualified'").get().n,
    today:     db.prepare("SELECT COUNT(*) as n FROM leads WHERE date(created_at)=date('now')").get().n,
  };
}

module.exports = { getDb, upsertLead, getLeads, updateLeadStatus, logOutreach, logScrape, getStats };
