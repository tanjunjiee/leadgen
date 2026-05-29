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
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT NOT NULL,
      address             TEXT,
      area                TEXT,
      category            TEXT NOT NULL,
      subcategory         TEXT,
      phone               TEXT,
      phone_type          TEXT,
      email               TEXT,
      instagram           TEXT,
      website             TEXT,
      google_place_id     TEXT UNIQUE,
      rating              REAL,
      review_count        INTEGER,
      score               INTEGER DEFAULT 0,
      is_chain            INTEGER DEFAULT 0,
      is_solo             INTEGER DEFAULT 0,
      canonical_name      TEXT,
      chain_size          INTEGER DEFAULT 1,
      best_dm_phone       TEXT,
      best_dm_email       TEXT,
      all_chain_contacts  TEXT,
      ab_variant          TEXT DEFAULT 'A',
      status              TEXT DEFAULT 'new',
      outreach_channel    TEXT,
      last_contacted_at   TEXT,
      notes               TEXT,
      review_snippets     TEXT,
      editorial_summary   TEXT,
      created_at          TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS outreach_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id   INTEGER NOT NULL,
      channel   TEXT NOT NULL,
      message   TEXT NOT NULL,
      ab_variant TEXT,
      sent_at   TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );

    CREATE TABLE IF NOT EXISTS reply_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id   INTEGER NOT NULL,
      reply_text TEXT,
      next_step  TEXT,
      logged_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );

    CREATE TABLE IF NOT EXISTS scrape_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      query     TEXT,
      results   INTEGER DEFAULT 0,
      new_leads INTEGER DEFAULT 0,
      ran_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_leads_status        ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_category      ON leads(category);
    CREATE INDEX IF NOT EXISTS idx_leads_score         ON leads(score DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_canonical     ON leads(canonical_name);
    CREATE INDEX IF NOT EXISTS idx_leads_is_chain      ON leads(is_chain);
  `);

  // Safe migrations for existing DBs
  const cols = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
  const add  = (col, type) => {
    if (!cols.includes(col)) db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${type}`);
  };
  add('review_snippets',    'TEXT');
  add('editorial_summary',  'TEXT');
  add('phone_type',         'TEXT');
  add('instagram',          'TEXT');
  add('is_chain',           'INTEGER DEFAULT 0');
  add('is_solo',            'INTEGER DEFAULT 0');
  add('canonical_name',     'TEXT');
  add('chain_size',         'INTEGER DEFAULT 1');
  add('best_dm_phone',      'TEXT');
  add('best_dm_email',      'TEXT');
  add('all_chain_contacts', 'TEXT');
  add('ab_variant',         "TEXT DEFAULT 'A'");

  // Reply log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS reply_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id    INTEGER NOT NULL,
      reply_text TEXT,
      next_step  TEXT,
      logged_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );
  `);
}

// ── Upsert ────────────────────────────────────────────────────
function upsertLead(lead) {
  const db  = getDb();
  const existing = db.prepare('SELECT id FROM leads WHERE google_place_id = ?').get(lead.google_place_id);
  const reviewJson    = lead.review_snippets    ? JSON.stringify(lead.review_snippets)    : null;
  const editorialText = lead.editorial_summary  || null;

  if (existing) {
    // Update enrichment data — preserve status, notes, outcomes
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
        instagram         = CASE WHEN @instagram != '' THEN @instagram ELSE instagram END,
        is_chain          = @is_chain,
        is_solo           = @is_solo,
        canonical_name    = @canonical_name,
        ab_variant        = CASE WHEN ab_variant IS NULL THEN @ab_variant ELSE ab_variant END,
        updated_at        = datetime('now')
      WHERE id = @id
    `).run({
      id:                existing.id,
      review_snippets:   reviewJson,
      editorial_summary: editorialText,
      rating:            lead.rating       || null,
      review_count:      lead.review_count || 0,
      score:             lead.score        || 0,
      phone:             lead.phone        || '',
      phone_type:        lead.phone_type   || '',
      email:             lead.email        || '',
      website:           lead.website      || '',
      instagram:         lead.instagram    || '',
      is_chain:          lead.is_chain     || 0,
      is_solo:           lead.is_solo      || 0,
      canonical_name:    lead.canonical_name || null,
      ab_variant:        lead.ab_variant   || 'A',
    });
    return { id: existing.id, isNew: false };
  }

  const result = db.prepare(`
    INSERT INTO leads (
      name, address, area, category, subcategory,
      phone, phone_type, email, instagram, website, google_place_id,
      rating, review_count, score,
      review_snippets, editorial_summary,
      is_chain, is_solo, canonical_name, ab_variant
    ) VALUES (
      @name, @address, @area, @category, @subcategory,
      @phone, @phone_type, @email, @instagram, @website, @google_place_id,
      @rating, @review_count, @score,
      @review_snippets, @editorial_summary,
      @is_chain, @is_solo, @canonical_name, @ab_variant
    )
  `).run({
    ...lead,
    review_snippets:   reviewJson,
    editorial_summary: editorialText,
    instagram:         lead.instagram || '',
  });

  return { id: result.lastInsertRowid, isNew: true };
}

// ── Queries ───────────────────────────────────────────────────
function getLeadById(id) {
  const row = getDb().prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!row) return null;
  return parseRow(row);
}

function getLeads({ status, category, minScore, limit = 1000, offset = 0 } = {}) {
  let query  = 'SELECT * FROM leads WHERE 1=1';
  const params = [];

  if (status)   { query += ' AND status = ?';   params.push(status); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  if (minScore) { query += ' AND score >= ?';   params.push(minScore); }

  // Include all mobile formats + email leads
  query += ` AND (
    phone LIKE '+65 8%' OR phone LIKE '+65 9%' OR
    phone LIKE '+658%'  OR phone LIKE '+659%'  OR
    phone LIKE '8%'     OR phone LIKE '9%'     OR
    (email IS NOT NULL AND email != '')
  )`;

  query += ' ORDER BY score DESC, created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return getDb().prepare(query).all(...params).map(parseRow);
}

// Leads needing follow-up (contacted but no reply, follow-up due)
function getFollowUpsDue() {
  return getDb().prepare(`
    SELECT * FROM leads
    WHERE status = 'contacted'
      AND last_contacted_at IS NOT NULL
      AND datetime(last_contacted_at, '+1 day') <= datetime('now')
    ORDER BY last_contacted_at ASC
  `).all().map(parseRow);
}

// Replied leads with no next step logged
function getRepliedNeedingNextStep() {
  return getDb().prepare(`
    SELECT l.* FROM leads l
    LEFT JOIN reply_log r ON r.lead_id = l.id
    WHERE l.status = 'replied'
      AND (r.next_step IS NULL OR r.next_step = '')
    ORDER BY l.score DESC
  `).all().map(parseRow);
}

// Hot new leads not yet contacted, sorted by score
function getHotNewLeads(limit = 10) {
  return getDb().prepare(`
    SELECT * FROM leads
    WHERE status = 'new' AND score >= 60
    ORDER BY score DESC, created_at DESC
    LIMIT ?
  `).all(limit).map(parseRow);
}

function updateLeadStatus(id, status) {
  const db  = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE leads SET
      status = ?,
      last_contacted_at = CASE WHEN ? = 'contacted' THEN ? ELSE last_contacted_at END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status, status, now, id);
}

function logOutreach(leadId, channel, message, abVariant) {
  return getDb().prepare(
    'INSERT INTO outreach_log (lead_id, channel, message, ab_variant) VALUES (?, ?, ?, ?)'
  ).run(leadId, channel, message, abVariant || null);
}

function logReply(leadId, replyText, nextStep) {
  return getDb().prepare(
    'INSERT INTO reply_log (lead_id, reply_text, next_step) VALUES (?, ?, ?)'
  ).run(leadId, replyText || '', nextStep || '');
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
    chains:    db.prepare("SELECT COUNT(*) as n FROM leads WHERE is_chain=1").get().n,
    today:     db.prepare("SELECT COUNT(*) as n FROM leads WHERE date(created_at)=date('now')").get().n,
  };
}

function getConversionStats() {
  return getDb().prepare(`
    SELECT
      subcategory,
      COUNT(*)  as total,
      SUM(CASE WHEN status IN ('replied','qualified','closed') THEN 1 ELSE 0 END) as replied,
      SUM(CASE WHEN status IN ('qualified','closed')           THEN 1 ELSE 0 END) as converted,
      ROUND(AVG(score), 1) as avg_score,
      ab_variant,
      COUNT(CASE WHEN ab_variant='A' AND status IN ('replied','qualified','closed') THEN 1 END) as a_replied,
      COUNT(CASE WHEN ab_variant='B' AND status IN ('replied','qualified','closed') THEN 1 END) as b_replied,
      COUNT(CASE WHEN ab_variant='A' THEN 1 END) as a_total,
      COUNT(CASE WHEN ab_variant='B' THEN 1 END) as b_total
    FROM leads
    WHERE status != 'new'
    GROUP BY subcategory, ab_variant
    ORDER BY replied DESC
  `).all();
}

// Rescore all existing leads using current scoring logic
function rescoreAllLeads() {
  const { scoreLead } = require('./qualifier');
  const db    = getDb();
  const leads = db.prepare('SELECT * FROM leads').all();
  let updated = 0;

  for (const lead of leads) {
    const place = {
      name:                    lead.name,
      international_phone_number: lead.phone,
      formatted_phone_number:  lead.phone,
      email:                   lead.email,
      website:                 lead.website,
      business_status:         'OPERATIONAL',
      rating:                  lead.rating,
      user_ratings_total:      lead.review_count,
      reviews:                 lead.review_snippets ? JSON.parse(lead.review_snippets) : [],
      editorial_summary:       lead.editorial_summary ? { overview: lead.editorial_summary } : null,
    };
    const { score, is_chain, is_solo } = scoreLead(place, lead.subcategory, lead.is_chain === 1);
    db.prepare('UPDATE leads SET score = ?, is_solo = ?, updated_at = datetime("now") WHERE id = ?')
      .run(score, is_solo ? 1 : 0, lead.id);
    updated++;
  }
  return updated;
}

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    review_snippets:    row.review_snippets    ? JSON.parse(row.review_snippets)    : [],
    all_chain_contacts: row.all_chain_contacts ? JSON.parse(row.all_chain_contacts) : null,
  };
}

module.exports = {
  getDb, upsertLead, getLeadById, getLeads,
  getFollowUpsDue, getRepliedNeedingNextStep, getHotNewLeads,
  updateLeadStatus, logOutreach, logReply, logScrape,
  getStats, getConversionStats, rescoreAllLeads,
};