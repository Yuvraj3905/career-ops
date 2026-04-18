# Email Outreach Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email discovery (pattern guessing + SMTP verification) and Gmail sending to the existing outreach pipeline, so approved leads get both a LinkedIn connection request and a cold email.

**Architecture:** Two new scripts (`email-discover.mjs`, `send-email.mjs`) plug into the existing SQLite-backed pipeline. The DB gets three new columns. `outreach.mjs` orchestrates the new email discovery step between enrichment and drafting, and gains a `send-emails` subcommand.

**Tech Stack:** Node.js (ESM), `nodemailer` (Gmail SMTP), built-in `dns` and `net` modules (MX lookup + SMTP RCPT TO verification), `better-sqlite3` (existing), `js-yaml` (existing)

**Spec:** `docs/superpowers/specs/2026-04-16-email-outreach-pipeline-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `email-discover.mjs` | Create | Email pattern generation + DNS/SMTP verification |
| `send-email.mjs` | Create | Gmail SMTP sender with rate limiting |
| `outreach-db.mjs` | Modify | Add `verified_email`, `email_status`, `email_sent_at` columns + new query helpers |
| `outreach.mjs` | Modify | Add email discovery step to `scan`, add `send-emails` command, extend `review`/`status` |
| `config/outreach.yml` | Modify | Add `email:` config block |
| `modes/outreach.md` | Modify | Document email workflow |
| `package.json` | Modify | Add `nodemailer` dep + `outreach:email` script |

---

### Task 1: Install nodemailer and add npm script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install nodemailer**

```bash
cd /home/13843K/Desktop/mygitprojects/career-ops && npm install nodemailer
```

- [ ] **Step 2: Verify nodemailer is in package.json dependencies**

```bash
node -e "const p = require('./package.json'); console.log(p.dependencies.nodemailer)"
```

Expected: `^x.x.x` (version string)

- [ ] **Step 3: Add outreach:email npm script**

In `package.json`, add to the `"scripts"` block:

```json
"outreach:email": "node send-email.mjs"
```

The scripts block should look like:

```json
"scripts": {
    "doctor": "node doctor.mjs",
    "verify": "node verify-pipeline.mjs",
    "normalize": "node normalize-statuses.mjs",
    "dedup": "node dedup-tracker.mjs",
    "merge": "node merge-tracker.mjs",
    "pdf": "node generate-pdf.mjs",
    "sync-check": "node cv-sync-check.mjs",
    "update:check": "node update-system.mjs check",
    "update": "node update-system.mjs apply",
    "rollback": "node update-system.mjs rollback",
    "liveness": "node check-liveness.mjs",
    "scan": "node scan.mjs",
    "outreach": "node outreach.mjs",
    "outreach:send": "node send-outreach.mjs",
    "outreach:login": "node send-outreach.mjs --login",
    "outreach:query": "node outreach-query-gen.mjs",
    "outreach:email": "node send-email.mjs"
}
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add nodemailer dependency for email outreach pipeline"
```

---

### Task 2: Add email columns to outreach-db.mjs

**Files:**
- Modify: `outreach-db.mjs:20-44` (CREATE_TABLE_SQL)
- Modify: `outreach-db.mjs` (add new helper functions)

- [ ] **Step 1: Add columns to CREATE TABLE**

In `outreach-db.mjs`, update `CREATE_TABLE_SQL` to add three columns after `error TEXT`:

```sql
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
  error TEXT,
  verified_email TEXT,
  email_status TEXT DEFAULT NULL,
  email_sent_at TEXT
);
```

- [ ] **Step 2: Add migration for existing databases**

After the `_db.exec(CREATE_TABLE_SQL)` line in `getDb()`, add ALTER TABLE statements wrapped in try-catch (SQLite errors if column already exists):

```javascript
// Migrate: add email columns if they don't exist
const migrations = [
  'ALTER TABLE leads ADD COLUMN verified_email TEXT',
  'ALTER TABLE leads ADD COLUMN email_status TEXT DEFAULT NULL',
  'ALTER TABLE leads ADD COLUMN email_sent_at TEXT',
];
for (const sql of migrations) {
  try { _db.exec(sql); } catch (_) { /* column already exists */ }
}
```

- [ ] **Step 3: Add `updateVerifiedEmail` function**

After the `updateStatus` function (line ~176), add:

```javascript
/**
 * Update a lead with a verified email address.
 * @param {string} profileUrl
 * @param {string|null} verifiedEmail
 * @param {string} emailStatus - 'verified' | 'unverifiable'
 */
export function updateVerifiedEmail(profileUrl, verifiedEmail, emailStatus) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE leads SET
      verified_email = @verified_email,
      email_status   = @email_status
    WHERE profile_url = @profile_url
  `);
  stmt.run({
    profile_url: profileUrl,
    verified_email: verifiedEmail,
    email_status: emailStatus,
  });
}
```

- [ ] **Step 4: Add `updateEmailSent` function**

```javascript
/**
 * Mark a lead's email as sent.
 * @param {string} profileUrl
 */
export function updateEmailSent(profileUrl) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE leads SET
      email_status  = 'sent',
      email_sent_at = @email_sent_at
    WHERE profile_url = @profile_url
  `);
  stmt.run({
    profile_url: profileUrl,
    email_sent_at: new Date().toISOString(),
  });
}
```

- [ ] **Step 5: Add `getLeadsForEmailDiscovery` function**

```javascript
/**
 * Get enriched leads that haven't had email discovery yet.
 * @returns {object[]}
 */
export function getLeadsForEmailDiscovery() {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM leads WHERE status IN ('enriched', 'drafted', 'approved') AND (email_status IS NULL OR email_status = 'pending') ORDER BY discovered_at DESC"
  ).all();
}
```

- [ ] **Step 6: Add `getLeadsForEmailSending` function**

```javascript
/**
 * Get approved leads with verified emails that haven't been emailed yet.
 * @returns {object[]}
 */
export function getLeadsForEmailSending() {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM leads WHERE status = 'approved' AND verified_email IS NOT NULL AND email_status = 'verified' ORDER BY discovered_at DESC"
  ).all();
}
```

- [ ] **Step 7: Add `getTodayEmailSendCount` function**

```javascript
/**
 * Count how many emails were sent today (UTC date).
 * @returns {number}
 */
export function getTodayEmailSendCount() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM leads WHERE email_status = 'sent' AND email_sent_at LIKE ?"
  ).get(`${today}%`);
  return row ? row.count : 0;
}
```

- [ ] **Step 8: Add `getEmailStats` function**

```javascript
/**
 * Return email-specific stats.
 * @returns {{ verified: number, unverifiable: number, sent: number, pending: number, bounced: number }}
 */
export function getEmailStats() {
  const db = getDb();
  const rows = db.prepare(
    'SELECT email_status, COUNT(*) AS count FROM leads WHERE email_status IS NOT NULL GROUP BY email_status'
  ).all();

  const stats = { verified: 0, unverifiable: 0, sent: 0, pending: 0, bounced: 0 };
  for (const row of rows) {
    if (row.email_status in stats) {
      stats[row.email_status] = row.count;
    }
  }
  return stats;
}
```

- [ ] **Step 9: Update exports at the top-level (verify all new functions are exported)**

All new functions use `export function` so they're already exported. Verify by running:

```bash
node -e "import('./outreach-db.mjs').then(m => console.log(Object.keys(m).join(', ')))"
```

Expected: should include `updateVerifiedEmail`, `updateEmailSent`, `getLeadsForEmailDiscovery`, `getLeadsForEmailSending`, `getTodayEmailSendCount`, `getEmailStats`

- [ ] **Step 10: Commit**

```bash
git add outreach-db.mjs
git commit -m "feat: add email columns and helper functions to outreach database"
```

---

### Task 3: Create email-discover.mjs

**Files:**
- Create: `email-discover.mjs`

- [ ] **Step 1: Create the file with full implementation**

Create `email-discover.mjs`:

```javascript
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
```

- [ ] **Step 2: Verify the script parses without errors**

```bash
node --check email-discover.mjs
```

Expected: no output (clean parse)

- [ ] **Step 3: Test dry-run mode**

```bash
node email-discover.mjs --dry-run
```

Expected: either "No leads pending email discovery." or a list of leads with name/domain/pattern info.

- [ ] **Step 4: Commit**

```bash
git add email-discover.mjs
git commit -m "feat: add email discovery script with pattern guessing and SMTP verification"
```

---

### Task 4: Create send-email.mjs

**Files:**
- Create: `send-email.mjs`

- [ ] **Step 1: Create the file with full implementation**

Create `send-email.mjs`:

```javascript
#!/usr/bin/env node
/**
 * send-email.mjs -- Gmail SMTP email sender for outreach pipeline
 *
 * Commands:
 *   node send-email.mjs              Send emails to approved leads with verified emails
 *   node send-email.mjs --dry-run    Preview emails that would be sent
 *   node send-email.mjs --limit <n>  Send at most n emails this run
 *
 * Reads: config/outreach.yml, config/profile.yml
 * Uses:  outreach-db.mjs (SQLite), nodemailer (SMTP)
 */

import nodemailer from 'nodemailer';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  getLeadsForEmailSending,
  updateEmailSent,
  updateVerifiedEmail,
  getTodayEmailSendCount,
  closeDb,
} from './outreach-db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  const outreachPath = join(__dirname, 'config', 'outreach.yml');
  const profilePath = join(__dirname, 'config', 'profile.yml');

  if (!existsSync(outreachPath)) {
    throw new Error('config/outreach.yml not found. Run setup first.');
  }
  if (!existsSync(profilePath)) {
    throw new Error('config/profile.yml not found. Run setup first.');
  }

  const outreach = yaml.load(readFileSync(outreachPath, 'utf-8'));
  const profile = yaml.load(readFileSync(profilePath, 'utf-8'));
  return { outreach, profile };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sleep for a random duration between min and max seconds.
 * @param {number} minSec
 * @param {number} maxSec
 */
async function randomDelay(minSec, maxSec) {
  const ms = Math.floor(Math.random() * (maxSec - minSec + 1) + minSec) * 1000;
  console.log(`  Waiting ${Math.round(ms / 1000)}s before next email...`);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const userLimit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

  let outreach, profile;
  try {
    ({ outreach, profile } = loadConfig());
  } catch (err) {
    console.error('Config error:', err.message);
    process.exit(1);
  }

  // Validate email config
  const emailConfig = outreach.email ?? {};
  const appPassword = emailConfig.app_password;
  if (!appPassword) {
    console.error(
      [
        'Email sending requires a Gmail App Password.',
        '',
        '1. Go to myaccount.google.com/apppasswords',
        '2. Generate a password for "Mail"',
        '3. Paste it into config/outreach.yml under email.app_password',
        '',
        'No emails were sent.',
      ].join('\n')
    );
    process.exit(1);
  }

  const senderEmail = emailConfig.sender_email || profile.candidate?.email;
  const senderName = profile.candidate?.full_name ?? 'Unknown';
  if (!senderEmail) {
    console.error('No sender email configured. Set email.sender_email in outreach.yml or candidate.email in profile.yml.');
    process.exit(1);
  }

  const maxPerDay = emailConfig.max_sends_per_day ?? 15;
  const delayRange = emailConfig.delay_between_sends ?? [180, 480];
  const smtpHost = emailConfig.smtp_host ?? 'smtp.gmail.com';
  const smtpPort = emailConfig.smtp_port ?? 587;

  // Check daily limit
  const todaySent = getTodayEmailSendCount();
  const remaining = maxPerDay - todaySent;

  if (remaining <= 0) {
    console.log(`Daily email limit reached (${todaySent}/${maxPerDay} sent today). Try again tomorrow.`);
    closeDb();
    return;
  }

  console.log(`Daily email quota: ${todaySent} sent today, ${remaining} remaining (limit: ${maxPerDay})`);

  // Get leads ready for email
  const allLeads = getLeadsForEmailSending();

  if (allLeads.length === 0) {
    console.log('No approved leads with verified emails to send. Run email discovery and approve leads first.');
    closeDb();
    return;
  }

  // Slice to remaining quota and user limit
  const maxToSend = Math.min(remaining, userLimit);
  const toSend = allLeads.slice(0, maxToSend);

  if (dryRun) {
    console.log(`\n[DRY RUN] Would send ${toSend.length} email(s):\n`);
    for (const lead of toSend) {
      console.log(`  To: ${lead.verified_email}`);
      console.log(`  Name: ${lead.name ?? 'Unknown'}`);
      console.log(`  Company: ${lead.company ?? 'Unknown'}`);
      console.log(`  Subject: ${lead.email_subject ?? '(no subject)'}`);
      console.log(`  Body preview: ${(lead.email_body ?? '').slice(0, 100)}...`);
      console.log();
    }
    closeDb();
    return;
  }

  // Create SMTP transporter
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: false, // TLS via STARTTLS
    auth: {
      user: senderEmail,
      pass: appPassword,
    },
  });

  // Verify SMTP connection
  try {
    await transporter.verify();
    console.log('SMTP connection verified.\n');
  } catch (err) {
    console.error(`SMTP connection failed: ${err.message}`);
    console.error('Check your email.app_password in config/outreach.yml.');
    closeDb();
    process.exit(1);
  }

  console.log(`Sending ${toSend.length} email(s)...\n`);

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < toSend.length; i++) {
    const lead = toSend[i];
    const label = lead.name ?? lead.verified_email;

    console.log(`[${i + 1}/${toSend.length}] Sending to: ${label} <${lead.verified_email}>`);

    if (!lead.email_subject || !lead.email_body) {
      console.log('  Skipping -- no email draft available.');
      failed++;
      continue;
    }

    try {
      await transporter.sendMail({
        from: `${senderName} <${senderEmail}>`,
        to: lead.verified_email,
        subject: lead.email_subject,
        text: lead.email_body,
      });

      updateEmailSent(lead.profile_url);
      sent++;
      console.log('  Sent successfully.');
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
      updateVerifiedEmail(lead.profile_url, lead.verified_email, 'bounced');
      failed++;

      // Stop on auth errors -- no point continuing
      if (err.responseCode === 535 || err.code === 'EAUTH') {
        console.error('\nAuthentication failed. Check your app password. Halting.');
        break;
      }
    }

    // Delay between sends (skip after the last one)
    if (i < toSend.length - 1) {
      await randomDelay(delayRange[0], delayRange[1]);
    }
  }

  console.log(`\nDone. Sent: ${sent}, Failed: ${failed}`);

  transporter.close();
  closeDb();
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  closeDb();
  process.exit(1);
});
```

- [ ] **Step 2: Verify the script parses without errors**

```bash
node --check send-email.mjs
```

Expected: no output (clean parse)

- [ ] **Step 3: Test dry-run mode (will fail gracefully if no approved leads)**

```bash
node send-email.mjs --dry-run
```

Expected: if app_password is empty, shows the setup instructions. Otherwise shows leads or "No approved leads" message.

- [ ] **Step 4: Commit**

```bash
git add send-email.mjs
git commit -m "feat: add Gmail SMTP email sender for outreach pipeline"
```

---

### Task 5: Add email config to outreach.yml

**Files:**
- Modify: `config/outreach.yml`

- [ ] **Step 1: Add email config block**

Append to `config/outreach.yml`:

```yaml

email:
  sender_email: ""          # defaults to profile.yml candidate.email if empty
  app_password: ""          # Gmail App Password (REQUIRED for sending)
  max_sends_per_day: 15
  delay_between_sends: [180, 480]   # 3-8 minutes in seconds
  smtp_host: "smtp.gmail.com"
  smtp_port: 587
  verify_timeout_ms: 5000          # SMTP verification timeout per address
  max_verifications_per_second: 2
```

- [ ] **Step 2: Verify YAML parses correctly**

```bash
node -e "import('js-yaml').then(y => { const fs = require('fs'); console.log(JSON.stringify(y.load(fs.readFileSync('config/outreach.yml','utf-8')).email, null, 2)) })"
```

Expected: JSON output showing the email config block.

- [ ] **Step 3: Commit**

```bash
git add config/outreach.yml
git commit -m "feat: add email config block to outreach.yml"
```

---

### Task 6: Integrate email discovery into outreach.mjs

**Files:**
- Modify: `outreach.mjs`

- [ ] **Step 1: Add email-related imports**

In `outreach.mjs`, update the import from `./outreach-db.mjs` (line 21-30) to include new functions:

```javascript
import {
  insertLead,
  updateEnrichment,
  updateDraft,
  updateStatus,
  getLeadsByStatus,
  getLeadsForEmailDiscovery,
  getLeadsForEmailSending,
  leadExists,
  getStats,
  getEmailStats,
  getTodaySendCount,
  getTodayEmailSendCount,
  closeDb,
} from './outreach-db.mjs';
```

- [ ] **Step 2: Add runEmailDiscovery stage function**

After `runDrafting` function (around line 345), add:

```javascript
/**
 * Stage 2.5: Email Discovery -- find and verify email addresses for enriched leads.
 * Calls email-discover.mjs as a subprocess.
 * @param {boolean} dryRun
 */
async function runEmailDiscovery(dryRun) {
  const leads = getLeadsForEmailDiscovery();

  if (leads.length === 0) {
    process.stderr.write('[email-discover] No leads pending email discovery.\n');
    return;
  }

  process.stderr.write(`[email-discover] Running discovery for ${leads.length} lead(s)...\n`);

  const scriptPath = join(__dirname, 'email-discover.mjs');
  const args = dryRun ? ['--dry-run'] : [];
  const result = spawnSync('node', [scriptPath, ...args], {
    cwd: __dirname,
    encoding: 'utf-8',
    timeout: 300000, // 5 min timeout for SMTP checks
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env },
  });

  if (result.error) {
    process.stderr.write(`[email-discover] Error: ${result.error.message}\n`);
  } else if (result.status !== 0) {
    process.stderr.write(`[email-discover] Exited with code ${result.status}\n`);
  }
}
```

- [ ] **Step 3: Insert email discovery into cmdScan**

Replace the `cmdScan` function (line ~351-373) with:

```javascript
async function cmdScan(outreachConfig, profile, cv, dryRun) {
  let queries;
  try {
    queries = resolveQueries(outreachConfig);
  } catch (err) {
    process.stderr.write(`[scan] Failed to resolve queries: ${err.message}\n`);
    process.exit(1);
  }

  if (dryRun) {
    process.stderr.write(`[dry-run] Queries that would be used (${queries.length}):\n`);
    queries.forEach((q, i) => process.stderr.write(`  ${i + 1}. ${q}\n`));
    process.stderr.write('[dry-run] No scout/enrich/draft calls will be made.\n');
  } else {
    process.stderr.write(`[scan] Starting pipeline with ${queries.length} query/queries...\n`);
  }

  await runScout(outreachConfig, queries, dryRun);
  await runEnrichment(outreachConfig, dryRun);
  await runEmailDiscovery(dryRun);
  await runDrafting(outreachConfig, profile, cv, dryRun);

  process.stderr.write('[scan] Pipeline complete.\n');
}
```

- [ ] **Step 4: Extend cmdReview to show email info**

Replace the `cmdReview` function (line ~379-413) with:

```javascript
function cmdReview() {
  const appliedIndex = buildAppliedIndex();
  const draftedLeads = getLeadsByStatus('drafted');

  const queue = draftedLeads.map((lead) => {
    let appliedMatch = null;
    if (lead.company) {
      const key = lead.company.toLowerCase().trim();
      if (appliedIndex.has(key)) {
        const app = appliedIndex.get(key);
        appliedMatch = `Already applied to ${lead.company} (Report #${app.reportNum.padStart(3, '0')}, Score ${app.score})`;
      }
    }

    // Determine available channels
    const channels = [];
    if (lead.connection_note) channels.push('linkedin');
    if (lead.verified_email && (lead.email_status === 'verified' || lead.email_status === 'unverifiable')) {
      channels.push('email');
    }

    return {
      id: lead.id,
      name: lead.name,
      headline: lead.headline,
      company: lead.company,
      location: lead.location,
      about: lead.about,
      recent_posts: lead.recent_posts ? JSON.parse(lead.recent_posts) : [],
      rag_hook: lead.rag_hook,
      connection_note: lead.connection_note,
      verified_email: lead.verified_email,
      email_status: lead.email_status,
      email_subject: lead.email_subject,
      email_body: lead.email_body,
      channels,
      profile_url: lead.profile_url,
      applied_match: appliedMatch,
      discovered_at: lead.discovered_at,
    };
  });

  console.log(JSON.stringify({ queue, total: queue.length }, null, 2));
}
```

- [ ] **Step 5: Extend cmdStatus to show email stats**

Replace the `cmdStatus` function (line ~419-438) with:

```javascript
function cmdStatus() {
  const { total, byStatus } = getStats();
  const sentToday = getTodaySendCount();
  const emailSentToday = getTodayEmailSendCount();
  const emailStats = getEmailStats();

  const output = {
    total,
    found: byStatus.found ?? 0,
    enriched: byStatus.enriched ?? 0,
    drafted: byStatus.drafted ?? 0,
    approved: byStatus.approved ?? 0,
    sent: byStatus.sent ?? 0,
    skipped: byStatus.skipped ?? 0,
    send_failed: byStatus.send_failed ?? 0,
    unreachable: byStatus.unreachable ?? 0,
    draft_failed: byStatus.draft_failed ?? 0,
    sent_today: sentToday,
    email: {
      ...emailStats,
      sent_today: emailSentToday,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}
```

- [ ] **Step 6: Add send-emails command**

Update the help text in `main()` (line ~449-464):

```javascript
if (!command || command === 'help' || command === '--help') {
  process.stderr.write(
    [
      'Usage: node outreach.mjs <command> [--dry-run]',
      '',
      'Commands:',
      '  scan          Run Scout > Investigator > Email Discover > Copywriter pipeline',
      '  review        Output pending drafted leads as JSON',
      '  status        Output pipeline stats as JSON',
      '  send-emails   Send emails to approved leads with verified addresses',
      '',
      'Flags:',
      '  --dry-run  List queries / leads without calling bridges or writing to DB',
    ].join('\n') + '\n'
  );
  process.exit(0);
}
```

Update the command validation:

```javascript
if (!['scan', 'review', 'status', 'send-emails'].includes(command)) {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(1);
}
```

Add the `send-emails` case in the switch statement:

```javascript
try {
  switch (command) {
    case 'scan':
      await cmdScan(outreach, profile, cv, dryRun);
      break;
    case 'review':
      cmdReview();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'send-emails': {
      const scriptPath = join(__dirname, 'send-email.mjs');
      const sendArgs = dryRun ? ['--dry-run'] : [];
      const result = spawnSync('node', [scriptPath, ...sendArgs], {
        cwd: __dirname,
        encoding: 'utf-8',
        timeout: 600000,
        stdio: 'inherit',
        env: { ...process.env },
      });
      if (result.error) {
        process.stderr.write(`Error: ${result.error.message}\n`);
      }
      break;
    }
  }
} finally {
  closeDb();
}
```

- [ ] **Step 7: Verify outreach.mjs parses cleanly**

```bash
node --check outreach.mjs
```

Expected: no output (clean parse)

- [ ] **Step 8: Test updated help**

```bash
node outreach.mjs help
```

Expected: help text showing `send-emails` command and updated `scan` description.

- [ ] **Step 9: Test status command**

```bash
node outreach.mjs status
```

Expected: JSON output with `email` object containing `verified`, `unverifiable`, `sent`, `pending`, `bounced`, `sent_today`.

- [ ] **Step 10: Commit**

```bash
git add outreach.mjs
git commit -m "feat: integrate email discovery and sending into outreach pipeline"
```

---

### Task 7: Update modes/outreach.md

**Files:**
- Modify: `modes/outreach.md`

- [ ] **Step 1: Update sub-commands table**

Replace the sub-commands table at the top with:

```markdown
| Command | Description |
|---------|-------------|
| `/career-ops outreach` | Review pending drafts (approve, edit, skip) |
| `/career-ops outreach scan` | Run a new scout pipeline (includes email discovery) |
| `/career-ops outreach login` | Open browser for LinkedIn login |
| `/career-ops outreach status` | Show pipeline stats (LinkedIn + email) |
| `/career-ops outreach config` | Show/edit outreach.yml |
| `/career-ops outreach send-emails` | Send emails to approved leads |
```

- [ ] **Step 2: Add Email Discovery section after the Scan workflow**

After the Scan section's closing `---`, add:

```markdown
### Email Discovery (automatic during scan)

Email discovery runs automatically as part of `scan` between enrichment and drafting. It:

1. Parses the lead's name into first/last
2. Extracts company domain from enrichment data or email guesses
3. Generates email patterns (first.last@, first@, flast@, etc.)
4. Verifies via DNS MX lookup + SMTP RCPT TO
5. Stores the best verified email in the database

To run email discovery independently:

```bash
node email-discover.mjs              # all pending leads
node email-discover.mjs --dry-run    # preview only
node email-discover.mjs --lead <id>  # single lead
```

---
```

- [ ] **Step 3: Add Send Emails section after Email Discovery**

```markdown
### Send Emails (`/career-ops outreach send-emails`)

Send cold emails to approved leads that have verified email addresses.

```bash
node outreach.mjs send-emails
# or directly:
node send-email.mjs
node send-email.mjs --dry-run
node send-email.mjs --limit 5
```

**Requires:** Gmail App Password configured in `config/outreach.yml` under `email.app_password`.

Setup:
1. Go to myaccount.google.com/apppasswords
2. Generate a password for "Mail"
3. Add to `config/outreach.yml`:
   ```yaml
   email:
     app_password: "your-app-password-here"
   ```

---
```

- [ ] **Step 4: Update Review section lead display**

In the Review section, update the lead display template:

```markdown
```
--- Lead {N} of {total} ---
Name:        {name}
Headline:    {headline}
Company:     {company}
Channels:    {linkedin, email}
Note ({char_count}/300 chars):
  "{connection_note}"
Email to:    {verified_email} ({email_status})
Subject:     {email_subject}
```
```

- [ ] **Step 5: Add email safety rules to Safety section**

Add these lines to the Safety section at the bottom:

```markdown
- Maximum 15 emails per day (configurable in `outreach.yml` under `email.max_sends_per_day`)
- Random delay of 3-8 minutes between email sends
- Plain text only emails (no HTML, reduces spam score)
- Stop immediately on any Gmail authentication error
- Emails use the same approval gate as LinkedIn -- no email is sent without user approval
```

- [ ] **Step 6: Commit**

```bash
git add modes/outreach.md
git commit -m "docs: add email discovery and sending to outreach mode instructions"
```

---

### Task 8: End-to-end verification

- [ ] **Step 1: Verify all scripts parse cleanly**

```bash
node --check outreach-db.mjs && node --check email-discover.mjs && node --check send-email.mjs && node --check outreach.mjs && echo "All scripts OK"
```

Expected: `All scripts OK`

- [ ] **Step 2: Verify outreach.mjs status includes email stats**

```bash
node outreach.mjs status
```

Expected: JSON with `email` key containing `verified`, `unverifiable`, `sent`, `pending`, `bounced`, `sent_today`.

- [ ] **Step 3: Verify email-discover.mjs dry-run**

```bash
node email-discover.mjs --dry-run
```

Expected: either "No leads pending" or dry-run output with name/domain/patterns.

- [ ] **Step 4: Verify send-email.mjs surfaces config error clearly**

```bash
node send-email.mjs --dry-run
```

Expected: if app_password is empty, shows the setup instructions. Otherwise shows leads or "No approved leads" message.

- [ ] **Step 5: Run existing test suite to check for regressions**

```bash
node test-all.mjs --quick
```

Expected: all existing tests pass.

- [ ] **Step 6: Commit any fixes if needed**

If all checks pass, no commit necessary. If fixes were needed, commit them:

```bash
git add -A
git commit -m "fix: address issues found during end-to-end verification"
```
