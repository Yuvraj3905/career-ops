#!/usr/bin/env node
/**
 * email-discover.mjs -- Email discovery via pattern guessing + SMTP verification
 *
 * Commands:
 *   node email-discover.mjs              Discover emails for all enriched leads
 *   node email-discover.mjs --dry-run    Show what would be checked
 *   node email-discover.mjs --lead <id>  Discover for a single lead by ID
 *
 * Uses: outreach-db.mjs, Node built-in dns and net modules
 */

import { promises as dns } from 'node:dns';
import net from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  getDb,
  getLeadsForEmailDiscovery,
  updateVerifiedEmail,
  closeDb,
} from './outreach-db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  const outreachPath = join(__dirname, 'config', 'outreach.yml');
  if (!existsSync(outreachPath)) {
    throw new Error('config/outreach.yml not found. Run setup first.');
  }
  return yaml.load(readFileSync(outreachPath, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Name parsing
// ---------------------------------------------------------------------------

/**
 * Parse a full name into first and last name components.
 * Handles "First Last", "First Middle Last", "Last, First" formats.
 * @param {string} fullName
 * @returns {{ first: string, last: string } | null}
 */
function parseName(fullName) {
  if (!fullName) return null;

  // Remove titles, suffixes, emojis, special chars
  let cleaned = fullName
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Jr|Sr|III|II|IV|PhD|MBA|CTO|CEO|VP)\b\.?/gi, '')
    .replace(/[^\p{L}\s'-]/gu, '')
    .trim();

  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;

  const first = parts[0].toLowerCase();
  const last = parts[parts.length - 1].toLowerCase();

  return { first, last };
}

// ---------------------------------------------------------------------------
// Domain extraction
// ---------------------------------------------------------------------------

/**
 * Extract a company email domain from available lead data.
 * Tries: company website from enrichment, then guesses from company name.
 * @param {object} lead
 * @returns {string|null} domain like "acme.com"
 */
function extractDomain(lead) {
  // Try email_guesses first -- they often contain the domain
  if (lead.email_guesses) {
    let guesses;
    try {
      guesses = JSON.parse(lead.email_guesses);
    } catch (_) {
      guesses = [];
    }
    if (Array.isArray(guesses) && guesses.length > 0) {
      // Extract domain from first email guess
      const match = guesses[0].match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
      if (match) return match[1].toLowerCase();
    }
  }

  // Try experience data for company website
  if (lead.experience) {
    let exp;
    try {
      exp = JSON.parse(lead.experience);
    } catch (_) {
      exp = [];
    }
    if (Array.isArray(exp)) {
      for (const entry of exp) {
        if (entry.company_url) {
          const match = entry.company_url.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/i);
          if (match) return match[1].toLowerCase();
        }
      }
    }
  }

  // Guess domain from company name (simple heuristic)
  if (lead.company) {
    const slug = lead.company
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .replace(/\s+/g, '');
    if (slug.length >= 2) return `${slug}.com`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pattern generation
// ---------------------------------------------------------------------------

/**
 * Generate email pattern candidates ranked by probability.
 * @param {{ first: string, last: string }} name
 * @param {string} domain
 * @returns {string[]}
 */
function generatePatterns(name, domain) {
  const { first, last } = name;
  return [
    `${first}.${last}@${domain}`,      // most common (~60%)
    `${first}@${domain}`,               // common at small companies
    `${first[0]}${last}@${domain}`,     // flast
    `${first}${last[0]}@${domain}`,     // firstl
    `${first}_${last}@${domain}`,       // first_last
    `${last}@${domain}`,                // last@
    `${first}${last}@${domain}`,        // firstlast
  ];
}

// ---------------------------------------------------------------------------
// DNS MX lookup
// ---------------------------------------------------------------------------

/**
 * Check if a domain has MX records.
 * @param {string} domain
 * @returns {Promise<string|null>} MX hostname or null
 */
async function getMxHost(domain) {
  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) return null;
    // Return the highest priority (lowest number) MX
    records.sort((a, b) => a.priority - b.priority);
    return records[0].exchange;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SMTP verification
// ---------------------------------------------------------------------------

/**
 * Verify an email address via SMTP RCPT TO.
 * @param {string} email
 * @param {string} mxHost
 * @param {number} timeoutMs
 * @returns {Promise<'valid'|'invalid'|'error'>}
 */
function smtpVerify(email, mxHost, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let response = '';
    let resolved = false;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish('error'));
    socket.on('error', () => finish('error'));

    socket.on('data', (data) => {
      response += data.toString();

      // Process complete lines
      const lines = response.split('\r\n');
      response = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const code = parseInt(line.substring(0, 3), 10);
        if (isNaN(code)) continue;

        if (step === 0 && code === 220) {
          // Server greeting -- send EHLO
          step = 1;
          socket.write('EHLO verify.local\r\n');
        } else if (step === 1 && code === 250) {
          // EHLO accepted -- send MAIL FROM
          step = 2;
          socket.write('MAIL FROM:<verify@verify.local>\r\n');
        } else if (step === 2 && code === 250) {
          // MAIL FROM accepted -- send RCPT TO
          step = 3;
          socket.write(`RCPT TO:<${email}>\r\n`);
        } else if (step === 3) {
          // RCPT TO response
          socket.write('QUIT\r\n');
          if (code === 250) {
            finish('valid');
          } else if (code === 550 || code === 551 || code === 553) {
            finish('invalid');
          } else {
            finish('error');
          }
        }
      }
    });

    socket.connect(25, mxHost);
  });
}

/**
 * Check if a mail server is catch-all (accepts any address).
 * @param {string} domain
 * @param {string} mxHost
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function isCatchAll(domain, mxHost, timeoutMs = 5000) {
  const random = `xyztest${Date.now()}@${domain}`;
  const result = await smtpVerify(random, mxHost, timeoutMs);
  return result === 'valid';
}

// ---------------------------------------------------------------------------
// Main discovery logic
// ---------------------------------------------------------------------------

/**
 * Discover and verify email for a single lead.
 * @param {object} lead
 * @param {{ verifyTimeoutMs: number }} opts
 * @returns {Promise<{ email: string|null, status: string }>}
 */
async function discoverEmail(lead, opts) {
  const name = parseName(lead.name);
  if (!name) {
    return { email: null, status: 'unverifiable' };
  }

  const domain = extractDomain(lead);
  if (!domain) {
    return { email: null, status: 'unverifiable' };
  }

  // Check MX records
  const mxHost = await getMxHost(domain);
  if (!mxHost) {
    // No MX -- try existing email_guesses as-is
    if (lead.email_guesses) {
      let guesses;
      try { guesses = JSON.parse(lead.email_guesses); } catch (_) { guesses = []; }
      if (Array.isArray(guesses) && guesses.length > 0) {
        return { email: guesses[0], status: 'unverifiable' };
      }
    }
    return { email: null, status: 'unverifiable' };
  }

  // Check catch-all
  const catchAll = await isCatchAll(domain, mxHost, opts.verifyTimeoutMs);

  // Generate patterns
  const patterns = generatePatterns(name, domain);

  // Merge with existing guesses (prepend them -- they come from LinkedIn scraping)
  let allCandidates = [...patterns];
  if (lead.email_guesses) {
    let guesses;
    try { guesses = JSON.parse(lead.email_guesses); } catch (_) { guesses = []; }
    if (Array.isArray(guesses)) {
      // Deduplicate: put guesses first, then patterns not already in guesses
      const guessSet = new Set(guesses.map(g => g.toLowerCase()));
      const uniquePatterns = patterns.filter(p => !guessSet.has(p.toLowerCase()));
      allCandidates = [...guesses, ...uniquePatterns];
    }
  }

  if (catchAll) {
    // Server accepts everything -- can't verify, use most probable
    return { email: allCandidates[0], status: 'unverifiable' };
  }

  // SMTP verify each candidate
  for (const candidate of allCandidates) {
    const result = await smtpVerify(candidate, mxHost, opts.verifyTimeoutMs);
    if (result === 'valid') {
      return { email: candidate, status: 'verified' };
    }
    // Rate limit: brief pause between SMTP checks
    await new Promise(r => setTimeout(r, 500));
  }

  // None verified -- fallback to first guess as unverifiable
  if (allCandidates.length > 0) {
    return { email: allCandidates[0], status: 'unverifiable' };
  }

  return { email: null, status: 'unverifiable' };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const leadIdIdx = args.indexOf('--lead');
  const singleLeadId = leadIdIdx !== -1 ? parseInt(args[leadIdIdx + 1], 10) : null;

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('Config error:', err.message);
    process.exit(1);
  }

  const verifyTimeoutMs = config.email?.verify_timeout_ms ?? 5000;

  let leads;
  if (singleLeadId) {
    const db = getDb();
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(singleLeadId);
    if (!lead) {
      console.error(`Lead with ID ${singleLeadId} not found.`);
      closeDb();
      process.exit(1);
    }
    leads = [lead];
  } else {
    leads = getLeadsForEmailDiscovery();
  }

  if (leads.length === 0) {
    console.log('No leads pending email discovery.');
    closeDb();
    return;
  }

  console.log(`[email-discover] Processing ${leads.length} lead(s)...\n`);

  let verified = 0;
  let unverifiable = 0;
  let failed = 0;

  for (const lead of leads) {
    const label = lead.name ?? lead.profile_url;

    if (dryRun) {
      const name = parseName(lead.name);
      const domain = extractDomain(lead);
      console.log(`[dry-run] ${label}`);
      console.log(`  Name parts: ${name ? `${name.first} ${name.last}` : 'unparseable'}`);
      console.log(`  Domain: ${domain ?? 'unknown'}`);
      if (name && domain) {
        const patterns = generatePatterns(name, domain);
        console.log(`  Patterns: ${patterns.join(', ')}`);
      }
      console.log();
      continue;
    }

    console.log(`[email-discover] ${label}...`);
    try {
      const result = await discoverEmail(lead, { verifyTimeoutMs });
      updateVerifiedEmail(lead.profile_url, result.email, result.status);

      if (result.status === 'verified') {
        verified++;
        console.log(`  Verified: ${result.email}`);
      } else if (result.email) {
        unverifiable++;
        console.log(`  Unverifiable (best guess): ${result.email}`);
      } else {
        failed++;
        console.log(`  No email found`);
      }
    } catch (err) {
      failed++;
      console.error(`  Error: ${err.message}`);
      updateVerifiedEmail(lead.profile_url, null, 'unverifiable');
    }
  }

  if (!dryRun) {
    console.log(`\n[email-discover] Done. Verified: ${verified}, Unverifiable: ${unverifiable}, Failed: ${failed}`);
  }

  closeDb();
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  closeDb();
  process.exit(1);
});
