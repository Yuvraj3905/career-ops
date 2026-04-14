#!/usr/bin/env node

/**
 * send-linkedin-outreach.mjs
 *
 * Reads a CSV of LinkedIn targets and sends connection requests or DMs.
 * Uses the persistent Chrome session from outreach-chrome/.
 *
 * Usage:
 *   node send-linkedin-outreach.mjs                          # Process all targets
 *   node send-linkedin-outreach.mjs --dry-run                # Preview without sending
 *   node send-linkedin-outreach.mjs --limit 5                # Process first 5 only
 *   node send-linkedin-outreach.mjs --file path/to/file.csv  # Custom CSV path
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = join(__dirname, 'output/linkedin-outreach-targets.csv');
const RESULTS_LOG = join(__dirname, 'output/linkedin-outreach-results.csv');
const CHROME_DIR = resolve(__dirname, 'outreach-chrome');

// ── CSV Parser (simple, handles quoted fields) ──────────────

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (values[i] || '').trim(); });
    return row;
  });
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ── Helpers ─────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

// ── LinkedIn Actions ────────────────────────────────────────

async function checkConnectionStatus(page) {
  // Check if we're already connected (Message button visible without Connect)
  const buttons = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a'));
    return btns.map(b => ({
      tag: b.tagName,
      text: (b.textContent || '').trim().substring(0, 30),
      ariaLabel: (b.getAttribute('aria-label') || '').substring(0, 50),
    }));
  });

  const hasMessage = buttons.some(b => b.text === 'Message');
  const hasConnect = buttons.some(b => b.text === 'Connect' || b.ariaLabel.includes('connect'));
  const hasPending = buttons.some(b => b.text === 'Pending' || b.ariaLabel.includes('Pending'));

  if (hasPending) return 'pending';
  if (hasMessage && !hasConnect) return 'connected';
  if (hasConnect) return 'not_connected';
  return 'unknown';
}

async function sendConnectionRequest(page, note) {
  // Find and click Connect button
  const connectBtn = await page.$('button:has-text("Connect")');
  if (!connectBtn) {
    // Check More dropdown
    const moreBtn = await page.$('button:has-text("More")');
    if (moreBtn) {
      await moreBtn.click();
      await sleep(1500);
      const connectInMore = await page.$('[role="menuitem"]:has-text("Connect")');
      if (connectInMore) {
        await connectInMore.click();
      } else {
        return { success: false, reason: 'No Connect option in More menu' };
      }
    } else {
      return { success: false, reason: 'Connect button not found' };
    }
  } else {
    await connectBtn.click();
  }

  await sleep(2000);

  // Click "Add a note"
  const addNoteBtn = await page.$('button:has-text("Add a note")');
  if (addNoteBtn) {
    await addNoteBtn.click();
    await sleep(1000);
  }

  // Fill note (truncate to 300 chars for LinkedIn limit)
  const truncatedNote = note.substring(0, 295);
  const textarea = await page.$('textarea[name="message"]') || await page.$('#custom-message') || await page.$('textarea');
  if (textarea) {
    await textarea.fill(truncatedNote);
    await sleep(500);
  }

  // Click Send
  const sendBtn = await page.$('button:has-text("Send")');
  if (sendBtn) {
    await sendBtn.click();
    await sleep(2000);

    // Check for rate limit
    const errorModal = await page.$('.artdeco-modal:has-text("limit")');
    if (errorModal) {
      return { success: false, reason: 'rate_limited' };
    }
    return { success: true, type: 'connection_request' };
  }

  return { success: false, reason: 'Send button not found' };
}

async function sendDirectMessage(page, message) {
  // Click Message link/button
  const msgLink = await page.$('a:has-text("Message")');
  const msgBtn = await page.$('button:has-text("Message")');
  const target = msgLink || msgBtn;

  if (!target) {
    return { success: false, reason: 'Message button not found' };
  }

  await target.click({ force: true });
  await sleep(4000);

  // Find textbox in the messaging overlay
  const msgBox = await page.$('div.msg-form__contenteditable[role="textbox"]')
    || await page.$('div[role="textbox"][contenteditable="true"]');

  if (!msgBox) {
    return { success: false, reason: 'Message textbox not found' };
  }

  await msgBox.click({ force: true });
  await sleep(500);
  await page.keyboard.type(message, { delay: 5 });
  await sleep(1500);

  // Send
  const sendBtn = await page.$('button.msg-form__send-button');
  if (!sendBtn) {
    // Try finding any Send button in the overlay
    const btns = await page.$$('button');
    for (const btn of btns) {
      const text = await btn.textContent();
      if (text?.trim() === 'Send') {
        await btn.click({ force: true });
        await sleep(2000);
        return { success: true, type: 'direct_message' };
      }
    }
    return { success: false, reason: 'Send button not found in message overlay' };
  }

  await sendBtn.click({ force: true });
  await sleep(2000);
  return { success: true, type: 'direct_message' };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : Infinity;
  const fileIdx = args.indexOf('--file');
  const csvPath = fileIdx !== -1 ? args[fileIdx + 1] : DEFAULT_CSV;

  if (!existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(1);
  }

  if (!existsSync(CHROME_DIR)) {
    console.error('No Chrome profile found. Run: node send-outreach.mjs --login');
    process.exit(1);
  }

  const csvText = readFileSync(csvPath, 'utf-8');
  const targets = parseCSV(csvText).slice(0, limit);

  console.log(`${'='.repeat(50)}`);
  console.log(`LinkedIn Outreach — ${targets.length} targets`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`${'='.repeat(50)}\n`);

  if (dryRun) {
    targets.forEach((t, i) => {
      console.log(`${i + 1}. ${t['Name']} — ${t['Title']} @ ${t['Company']}`);
      console.log(`   Profile: ${t['LinkedIn Profile']}`);
      console.log(`   Message: ${t['Personalized Message'].substring(0, 80)}...`);
      console.log();
    });
    return;
  }

  // Launch browser
  const context = await chromium.launchPersistentContext(CHROME_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const results = [];

  try {
    const page = context.pages()[0] || await context.newPage();

    // Verify LinkedIn session
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);
    const url = page.url();
    if (url.includes('login') || url.includes('signup')) {
      console.error('LinkedIn session expired. Run: node send-outreach.mjs --login');
      await context.close();
      process.exit(1);
    }
    console.log('LinkedIn session active\n');

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const profileUrl = target['LinkedIn Profile'];
      const name = target['Name'];
      const message = target['Personalized Message'];

      console.log(`[${i + 1}/${targets.length}] ${name} — ${target['Title']} @ ${target['Company']}`);

      if (!profileUrl || !profileUrl.includes('linkedin.com')) {
        console.log('  SKIP: Invalid profile URL\n');
        results.push({ ...target, status: 'skipped', reason: 'invalid_url' });
        continue;
      }

      try {
        // Navigate to profile
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(5000);
        await page.keyboard.press('Escape'); // dismiss any modal
        await sleep(500);

        // Check connection status
        const status = await checkConnectionStatus(page);
        console.log(`  Status: ${status}`);

        if (status === 'pending') {
          console.log('  SKIP: Connection request already pending\n');
          results.push({ ...target, status: 'skipped', reason: 'already_pending' });
        } else if (status === 'connected') {
          // Send DM
          console.log('  Sending direct message...');
          const result = await sendDirectMessage(page, message);
          if (result.success) {
            console.log('  SENT (DM)\n');
            results.push({ ...target, status: 'sent', reason: 'direct_message' });
          } else {
            console.log(`  FAILED: ${result.reason}\n`);
            results.push({ ...target, status: 'failed', reason: result.reason });
          }
        } else if (status === 'not_connected') {
          // Send connection request with note
          console.log('  Sending connection request...');
          const result = await sendConnectionRequest(page, message);
          if (result.success) {
            console.log('  SENT (Connection request)\n');
            results.push({ ...target, status: 'sent', reason: 'connection_request' });
          } else if (result.reason === 'rate_limited') {
            console.log('  RATE LIMITED — stopping all sends\n');
            results.push({ ...target, status: 'rate_limited', reason: 'rate_limited' });
            break;
          } else {
            console.log(`  FAILED: ${result.reason}\n`);
            results.push({ ...target, status: 'failed', reason: result.reason });
          }
        } else {
          console.log('  SKIP: Could not determine connection status\n');
          results.push({ ...target, status: 'skipped', reason: 'unknown_status' });
        }
      } catch (err) {
        console.log(`  ERROR: ${err.message}\n`);
        results.push({ ...target, status: 'error', reason: err.message.substring(0, 100) });
      }

      // Delay between profiles (30-60 seconds)
      if (i < targets.length - 1) {
        const delay = randomDelay(30, 60);
        console.log(`  Waiting ${Math.round(delay / 1000)}s...\n`);
        await sleep(delay);
      }
    }
  } finally {
    await context.close();
  }

  // Write results log
  const sent = results.filter(r => r.status === 'sent').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${sent} sent, ${failed} failed, ${skipped} skipped`);
  console.log(`${'='.repeat(50)}`);

  // Save results CSV
  const header = '"#","Name","Company","Status","Type","Profile URL"';
  const rows = results.map((r, i) =>
    `"${i + 1}","${r['Name']}","${r['Company']}","${r.status}","${r.reason}","${r['LinkedIn Profile']}"`
  );
  writeFileSync(RESULTS_LOG, [header, ...rows].join('\n'), 'utf-8');
  console.log(`Results saved to: ${RESULTS_LOG}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
