#!/usr/bin/env node
/**
 * outreach.mjs — Main orchestrator for the outreach pipeline
 *
 * Commands:
 *   node outreach.mjs scan [--dry-run]   Run Scout → Investigator → Copywriter pipeline
 *   node outreach.mjs review             Output pending drafted leads as JSON
 *   node outreach.mjs status             Output pipeline stats as JSON
 *
 * Reads: config/outreach.yml, config/profile.yml, cv.md, data/applications.md
 * Calls: Nexus bridge scripts via spawnSync (Python)
 * Stores: results in SQLite via outreach-db.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
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

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadYaml(filePath) {
  return yaml.load(readFileSync(filePath, 'utf-8'));
}

function loadConfig() {
  const outreachPath = join(__dirname, 'config', 'outreach.yml');
  const profilePath = join(__dirname, 'config', 'profile.yml');

  if (!existsSync(outreachPath)) {
    throw new Error(`config/outreach.yml not found. Run setup first.`);
  }
  if (!existsSync(profilePath)) {
    throw new Error(`config/profile.yml not found. Run setup first.`);
  }

  const outreach = loadYaml(outreachPath);
  const profile = loadYaml(profilePath);
  const cvPath = join(__dirname, 'cv.md');
  const cv = existsSync(cvPath) ? readFileSync(cvPath, 'utf-8') : '';

  return { outreach, profile, cv };
}

// ---------------------------------------------------------------------------
// Bridge caller
// ---------------------------------------------------------------------------

/**
 * Call a Python bridge script via spawnSync.
 * @param {string} nexusPath - absolute path to Nexus-HeadHunter repo
 * @param {string} scriptName - filename in bridge/ subdirectory
 * @param {object} input - object to serialize as JSON stdin
 * @returns {object} parsed JSON response from the bridge
 */
function callBridge(nexusPath, scriptName, input) {
  const scriptPath = join(nexusPath, 'bridge', scriptName);
  if (!existsSync(scriptPath)) {
    throw new Error(`Bridge script not found: ${scriptPath}`);
  }

  // Use venv Python if available, otherwise fall back to python3
  const venvPython = join(nexusPath, '.venv', 'bin', 'python3');
  const pythonBin = existsSync(venvPython) ? venvPython : 'python3';

  const result = spawnSync(pythonBin, [scriptPath], {
    cwd: nexusPath,
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 120000,
    env: { ...process.env },
  });

  if (result.error) {
    throw new Error(`Bridge ${scriptName} failed: ${result.error.message}`);
  }
  if (!result.stdout) {
    throw new Error(
      `Bridge ${scriptName} exited ${result.status}: ${result.stderr || 'no output'}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(
      `Bridge ${scriptName} invalid JSON: ${result.stdout.slice(0, 200)}`
    );
  }

  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

// ---------------------------------------------------------------------------
// Query resolution
// ---------------------------------------------------------------------------

/**
 * Resolve search queries: manual from outreach.yml or auto-generated.
 * @param {object} outreachConfig
 * @returns {string[]}
 */
function resolveQueries(outreachConfig) {
  const manual = (outreachConfig.search?.queries || []).filter(Boolean);
  if (manual.length > 0) return manual;

  // Auto-generate via outreach-query-gen.mjs
  const genScript = join(__dirname, 'outreach-query-gen.mjs');
  const result = spawnSync('node', [genScript, '--json'], {
    cwd: __dirname,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env },
  });

  if (result.error || !result.stdout) {
    throw new Error(
      `Query generator failed: ${result.error?.message || result.stderr || 'no output'}`
    );
  }

  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(`Query generator invalid JSON: ${result.stdout.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Applications.md dedup index
// ---------------------------------------------------------------------------

/**
 * Parse data/applications.md to build a lookup of companies already applied to.
 * Returns a map: lowercase(company) → { reportNum, score }
 * @returns {Map<string, { reportNum: string, score: string }>}
 */
function buildAppliedIndex() {
  const appPath = join(__dirname, 'data', 'applications.md');
  const index = new Map();
  if (!existsSync(appPath)) return index;

  const lines = readFileSync(appPath, 'utf-8').split('\n');
  for (const line of lines) {
    // Match table rows: | num | date | company | role | score | status | pdf | report | notes |
    const m = line.match(/^\|\s*(\d+)\s*\|\s*[^|]+\|\s*([^|]+)\|\s*([^|]+)\|\s*([\d.]+\/5)/);
    if (!m) continue;
    const num = m[1].trim();
    const company = m[2].trim();
    const score = m[4].trim();
    index.set(company.toLowerCase(), { reportNum: num, score });
  }
  return index;
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

/**
 * Stage 1: Scout — search LinkedIn for leads matching each query.
 * @param {object} outreachConfig
 * @param {string[]} queries
 * @param {boolean} dryRun
 */
async function runScout(outreachConfig, queries, dryRun) {
  const nexusPath = outreachConfig.nexus_path;
  const maxLeads = outreachConfig.schedule?.max_leads_per_run ?? 15;

  let totalNew = 0;

  for (const query of queries) {
    if (dryRun) {
      process.stderr.write(`[dry-run] Would scout: ${query}\n`);
      continue;
    }

    process.stderr.write(`[scout] Querying: ${query}\n`);
    let response;
    try {
      response = callBridge(nexusPath, 'scout_bridge.py', {
        query,
        max_results: maxLeads,
        exclude_companies: outreachConfig.search?.exclude_companies || [],
      });
    } catch (err) {
      process.stderr.write(`[scout] Error for "${query}": ${err.message}\n`);
      continue;
    }

    const leads = response.leads || [];
    for (const lead of leads) {
      if (!lead.profile_url) continue;
      const isNew = insertLead(lead, query);
      if (isNew) {
        totalNew++;
        process.stderr.write(`[scout] New lead: ${lead.name || lead.profile_url}\n`);
      }
    }
  }

  if (!dryRun) {
    process.stderr.write(`[scout] Done. ${totalNew} new lead(s) inserted.\n`);
  }
}

/**
 * Stage 2: Investigator — enrich each 'found' lead with profile data.
 * @param {object} outreachConfig
 * @param {boolean} dryRun
 */
async function runEnrichment(outreachConfig, dryRun) {
  const nexusPath = outreachConfig.nexus_path;
  const foundLeads = getLeadsByStatus('found');

  if (foundLeads.length === 0) {
    process.stderr.write('[investigator] No leads with status "found" to enrich.\n');
    return;
  }

  process.stderr.write(`[investigator] Enriching ${foundLeads.length} lead(s)...\n`);

  for (const lead of foundLeads) {
    if (dryRun) {
      process.stderr.write(
        `[dry-run] Would enrich: ${lead.name || lead.profile_url}\n`
      );
      continue;
    }

    process.stderr.write(`[investigator] Enriching: ${lead.name || lead.profile_url}\n`);
    let response;
    try {
      response = callBridge(nexusPath, 'investigator_bridge.py', {
        profile_url: lead.profile_url,
        name: lead.name,
        company: lead.company,
      });
    } catch (err) {
      process.stderr.write(
        `[investigator] Error for ${lead.profile_url}: ${err.message}\n`
      );
      updateStatus(lead.profile_url, 'enriched', err.message);
      continue;
    }

    updateEnrichment(lead.profile_url, {
      about: response.about,
      experience: response.experience,
      recent_posts: response.recent_posts,
      email_guesses: response.email_guesses,
      rag_hook: response.rag_hook,
    });
    process.stderr.write(`[investigator] Enriched: ${lead.name || lead.profile_url}\n`);
  }
}

/**
 * Stage 3: Copywriter — draft outreach messages for each 'enriched' lead.
 * @param {object} outreachConfig
 * @param {object} profile - contents of profile.yml
 * @param {string} cv - contents of cv.md
 * @param {boolean} dryRun
 */
async function runDrafting(outreachConfig, profile, cv, dryRun) {
  const nexusPath = outreachConfig.nexus_path;
  const enrichedLeads = getLeadsByStatus('enriched');

  if (enrichedLeads.length === 0) {
    process.stderr.write('[copywriter] No leads with status "enriched" to draft.\n');
    return;
  }

  process.stderr.write(`[copywriter] Drafting messages for ${enrichedLeads.length} lead(s)...\n`);

  // Build candidate info from profile
  const candidate = {
    name: profile.candidate?.full_name ?? '',
    email: profile.candidate?.email ?? '',
    headline: profile.narrative?.headline ?? '',
    superpowers: profile.narrative?.superpowers ?? [],
    proof_points: profile.narrative?.proof_points ?? [],
    target_roles: profile.target_roles?.primary ?? [],
    cv_summary: cv.slice(0, 3000), // send first 3k chars to keep payload lean
  };

  for (const lead of enrichedLeads) {
    if (dryRun) {
      process.stderr.write(
        `[dry-run] Would draft message for: ${lead.name || lead.profile_url}\n`
      );
      continue;
    }

    process.stderr.write(`[copywriter] Drafting for: ${lead.name || lead.profile_url}\n`);
    let response;
    try {
      response = callBridge(nexusPath, 'copywriter_bridge.py', {
        lead: {
          profile_url: lead.profile_url,
          name: lead.name,
          headline: lead.headline,
          company: lead.company,
          location: lead.location,
          about: lead.about,
          experience: lead.experience ? JSON.parse(lead.experience) : [],
          recent_posts: lead.recent_posts ? JSON.parse(lead.recent_posts) : [],
          rag_hook: lead.rag_hook,
        },
        candidate,
      });
    } catch (err) {
      process.stderr.write(
        `[copywriter] Error for ${lead.profile_url}: ${err.message}\n`
      );
      updateStatus(lead.profile_url, 'draft_failed', err.message);
      continue;
    }

    updateDraft(lead.profile_url, {
      connection_note: response.connection_note,
      email_subject: response.email_subject,
      email_body: response.email_body,
    });
    process.stderr.write(`[copywriter] Drafted: ${lead.name || lead.profile_url}\n`);
  }
}

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

// ---------------------------------------------------------------------------
// Command: scan
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Command: review
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Command: status
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');

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

  if (!['scan', 'review', 'status', 'send-emails'].includes(command)) {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exit(1);
  }

  // Load configs (required for all commands)
  let outreach, profile, cv;
  try {
    ({ outreach, profile, cv } = loadConfig());
  } catch (err) {
    process.stderr.write(`Config error: ${err.message}\n`);
    process.exit(1);
  }

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
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  closeDb();
  process.exit(1);
});
