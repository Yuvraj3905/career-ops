#!/usr/bin/env node
/**
 * outreach-db.mjs — Shared SQLite database layer for the outreach pipeline
 *
 * Used by outreach.mjs and send-outreach.mjs.
 * Singleton connection, WAL journal mode, synchronous API (better-sqlite3).
 *
 * DB file: data/outreach.db  (gitignored)
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_PATH = join(__dirname, 'data', 'outreach.db');

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_url TEXT UNIQUE NOT NULL,
  name TEXT,
  headline TEXT,
  company TEXT,
  location TEXT,
  about TEXT,
  experience TEXT,
  recent_posts TEXT,
  email_guesses TEXT,
  rag_hook TEXT,
  connection_note TEXT,
  email_subject TEXT,
  email_body TEXT,
  status TEXT DEFAULT 'found',
  source_query TEXT,
  discovered_at TEXT,
  enriched_at TEXT,
  drafted_at TEXT,
  sent_at TEXT,
  error TEXT
);
`;

/** @type {import('better-sqlite3').Database | null} */
let _db = null;

/**
 * Initialize and return the singleton db connection.
 * Creates the data/ directory and table if needed.
 * @returns {import('better-sqlite3').Database}
 */
export function getDb() {
  if (_db) return _db;

  // Ensure data/ directory exists
  const dataDir = join(__dirname, 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(CREATE_TABLE_SQL);

  return _db;
}

/**
 * Insert a lead discovered from a search query.
 * Uses INSERT OR IGNORE so duplicates are silently skipped.
 * @param {{ profile_url: string, name?: string, headline?: string, company?: string, location?: string }} lead
 * @param {string} sourceQuery
 * @returns {boolean} true if a new row was inserted, false if it already existed
 */
export function insertLead(lead, sourceQuery) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO leads
      (profile_url, name, headline, company, location, status, source_query, discovered_at)
    VALUES
      (@profile_url, @name, @headline, @company, @location, 'found', @source_query, @discovered_at)
  `);
  const result = stmt.run({
    profile_url: lead.profile_url,
    name: lead.name ?? null,
    headline: lead.headline ?? null,
    company: lead.company ?? null,
    location: lead.location ?? null,
    source_query: sourceQuery,
    discovered_at: new Date().toISOString(),
  });
  return result.changes > 0;
}

/**
 * Update a lead with enrichment data scraped from their profile.
 * Sets status to 'enriched' and records enriched_at timestamp.
 * @param {string} profileUrl
 * @param {{ about?: string, experience?: any[], recent_posts?: any[], email_guesses?: string[], rag_hook?: string }} enrichment
 */
export function updateEnrichment(profileUrl, enrichment) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE leads SET
      about        = @about,
      experience   = @experience,
      recent_posts = @recent_posts,
      email_guesses = @email_guesses,
      rag_hook     = @rag_hook,
      status       = 'enriched',
      enriched_at  = @enriched_at,
      error        = NULL
    WHERE profile_url = @profile_url
  `);
  stmt.run({
    profile_url: profileUrl,
    about: enrichment.about ?? null,
    experience: enrichment.experience != null ? JSON.stringify(enrichment.experience) : null,
    recent_posts: enrichment.recent_posts != null ? JSON.stringify(enrichment.recent_posts) : null,
    email_guesses: enrichment.email_guesses != null ? JSON.stringify(enrichment.email_guesses) : null,
    rag_hook: enrichment.rag_hook ?? null,
    enriched_at: new Date().toISOString(),
  });
}

/**
 * Update a lead with drafted outreach copy.
 * Sets status to 'drafted' and records drafted_at timestamp.
 * @param {string} profileUrl
 * @param {{ connection_note?: string, email_subject?: string, email_body?: string }} draft
 */
export function updateDraft(profileUrl, draft) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE leads SET
      connection_note = @connection_note,
      email_subject   = @email_subject,
      email_body      = @email_body,
      status          = 'drafted',
      drafted_at      = @drafted_at
    WHERE profile_url = @profile_url
  `);
  stmt.run({
    profile_url: profileUrl,
    connection_note: draft.connection_note ?? null,
    email_subject: draft.email_subject ?? null,
    email_body: draft.email_body ?? null,
    drafted_at: new Date().toISOString(),
  });
}

/**
 * Update the status of a lead.
 * If status is 'sent', also records sent_at timestamp.
 * @param {string} profileUrl
 * @param {string} status - found|enriched|drafted|approved|skipped|sent|send_failed|unreachable
 * @param {string|null} [error]
 */
export function updateStatus(profileUrl, status, error = null) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE leads SET
      status  = @status,
      sent_at = CASE WHEN @status = 'sent' THEN @sent_at ELSE sent_at END,
      error   = @error
    WHERE profile_url = @profile_url
  `);
  stmt.run({
    profile_url: profileUrl,
    status,
    sent_at: new Date().toISOString(),
    error,
  });
}

/**
 * Get all leads with a given status, newest first.
 * @param {string} status
 * @returns {object[]}
 */
export function getLeadsByStatus(status) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM leads WHERE status = ? ORDER BY discovered_at DESC'
  ).all(status);
}

/**
 * Get a single lead by profile URL.
 * @param {string} profileUrl
 * @returns {object|undefined}
 */
export function getLeadByUrl(profileUrl) {
  const db = getDb();
  return db.prepare('SELECT * FROM leads WHERE profile_url = ?').get(profileUrl);
}

/**
 * Check whether a lead already exists in the database.
 * @param {string} profileUrl
 * @returns {boolean}
 */
export function leadExists(profileUrl) {
  const db = getDb();
  const row = db.prepare(
    'SELECT 1 FROM leads WHERE profile_url = ? LIMIT 1'
  ).get(profileUrl);
  return row !== undefined;
}

/**
 * Return per-status counts plus a total.
 * @returns {{ total: number, byStatus: Record<string, number> }}
 */
export function getStats() {
  const db = getDb();
  const rows = db.prepare(
    'SELECT status, COUNT(*) AS count FROM leads GROUP BY status'
  ).all();

  const byStatus = {};
  let total = 0;
  for (const row of rows) {
    byStatus[row.status] = row.count;
    total += row.count;
  }
  return { total, byStatus };
}

/**
 * Count how many messages were sent today (UTC date).
 * @returns {number}
 */
export function getTodaySendCount() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM leads WHERE status = 'sent' AND sent_at LIKE ?"
  ).get(`${today}%`);
  return row ? row.count : 0;
}

/**
 * Close the database connection and reset the singleton.
 * Call when the process is done with the database.
 */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
