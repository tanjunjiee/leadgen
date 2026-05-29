const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || '/tmp/leads.db';
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
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      address           TEXT,
      area              TEXT,
      category          TEXT NOT NULL,
      subcategory       TEXT,
      phone             TEXT,
      phone_type        TEXT,
      email             TEXT,
      website           TEXT,
      google_place_id   TEXT UNIQUE,
      rating            REAL,
      review_count      INTEGER,
      score             INTEGER DEFAULT 0,
      status            TEXT DEFAULT 'new',
      outreach_channel  TEXT,
      last_contacted_at TEXT,
      notes             TEXT,
      review_snippets   TEXT,
      editorial_summary TEXT,
      created_at        TEXT DEFAULT (datetime('now')),
      updated_at        TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS outreach_log (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id  INTEGER NOT NULL,
      channel  TEXT NOT NULL,
      message  TEXT NOT NULL,
      sent_at  TEXT DEFAULT (datetime('now')),
      approved INTEGER DEFAULT 0,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );

    CREATE TABLE IF NOT EXISTS scrape_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      query     TEXT,
      results   INTEGER DEFAULT 0,
      new_leads INTEGER DEFAULT 0,
      ran_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_leads_status   ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_category ON leads(category);
    CREATE INDEX IF NOT EXISTS idx_leads_score    ON leads(score DESC);
  `);

  // Migrate existing DBs safely
  const cols = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
  if (!cols.includes('review_snippets'))   db.exec('ALTER TABLE leads ADD COLUMN review_snippets TEXT');
  if (!cols.includes('editorial_summary')) db.exec('ALTER TABLE leads ADD COLUMN editorial_summary TEXT');
  if (!cols.includes('phone_type'))        db.exec('ALTER TABLE leads ADD COLUMN phone_type TEXT');
}

// ── Lead queries ──────────────────────────────────────────────

function upsertLead(lead) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM leads WHERE google_place_id = ?').get(lead.google_place_id);

  const reviewSnippetsJson = lead.review_snippets ? JSON.stringify(lead.review_snippets) : null;
  const editorialSummary   = lead.editorial_summary || null;

  if (existing) {
    // Always update review data, rating, score on re-scrape
    // so existing leads get enriched without losing status/notes
    db.prepare(`
      UPDATE leads SET
        review_snippets   = @review_snippets,
        editorial_summary = @editorial_summary,
        rating            = @rating,
        review_count      = @review_count,
        score             = @score,
        phone             = @phone,
        phone_type        = @phone_type,
        email             = CASE WHEN @email != '' THEN @email ELSE email END,
        website           = CASE WHEN @website != '' THEN @website ELSE website END,
        updated_at        = datetime('now')
      WHERE id = @id
    `).run({
      id:                existing.id,
      review_snippets:   reviewSnippetsJson,
      editorial_summary: editorialSummary,
      rating:            lead.rating || null,
      review_count:      lead.review_count || 0,
      score:             lead.score || 0,
      phone:             lead.phone || '',
      phone_type:        lead.phone_type || '',
      email:             lead.email || '',
      website:           lead.website || '',
    });
    return { id: existing.id, isNew: false };
  }

  const result = db.prepare(`
    INSERT INTO leads (
      name, address, area, category, subcategory,
      phone, phone_type, email, website, google_place_id,
      rating, review_count, score,
      review_snippets, editorial_summary
    ) VALUES (
      @name, @address, @area, @category, @subcategory,
      @phone, @phone_type, @email, @website, @google_place_id,
      @rating, @review_count, @score,
      @review_snippets, @editorial_summary
    )
  `).run({
    ...lead,
    review_snippets:   reviewSnippetsJson,
    editorial_summary: editorialSummary,
  });

  return { id: result.lastInsertRowid, isNew: true };
}

// Direct lookup by ID — avoids loading all leads to find one
function getLeadById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    review_snippets: row.review_snippets ? JSON.parse(row.review_snippets) : [],
  };
}

function getLeads({ status, category, minScore, limit = 100, offset = 0 } = {}) {
  const db = getDb();
  let query = 'SELECT * FROM leads WHERE 1=1';
  const params = [];
  if (status)   { query += ' AND status = ?';   params.push(status); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  if (minScore) { query += ' AND score >= ?';   params.push(minScore); }

  // Fix: handle both +65 8XXXXXXX (with space) and +658XXXXXXX (without space)
  query += ` AND (
    phone LIKE '+65 8%' OR phone LIKE '+65 9%' OR
    phone LIKE '+658%'  OR phone LIKE '+659%'  OR
    phone LIKE '8%'     OR phone LIKE '9%'     OR
    (email IS NOT NULL AND email != '')
  )`;

  query += ' ORDER BY score DESC, created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params);
  return rows.map(r => ({
    ...r,
    review_snippets: r.review_snippets ? JSON.parse(r.review_snippets) : [],
  }));
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

// Feedback loop — which subcategories/sizes actually convert
function getConversionStats() {
  const db = getDb();
  return db.prepare(`
    SELECT
      subcategory,
      COUNT(*) as total,
      SUM(CASE WHEN status IN ('replied','qualified') THEN 1 ELSE 0 END) as replied,
      SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) as converted,
      ROUND(AVG(score), 1) as avg_score
    FROM leads
    WHERE status != 'new'
    GROUP BY subcategory
    ORDER BY converted DESC
  `).all();
}

module.exports = { getDb, upsertLead, getLeadById, getLeads, updateLeadStatus, logOutreach, logScrape, getStats, getConversionStats };