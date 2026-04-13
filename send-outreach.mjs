#!/usr/bin/env node
/**
 * send-outreach.mjs — Playwright-based LinkedIn connection sender
 *
 * Commands:
 *   node send-outreach.mjs            Send approved leads (up to daily limit)
 *   node send-outreach.mjs --login    Open browser for manual LinkedIn login
 *   node send-outreach.mjs --dry-run  Show what would be sent without sending
 *
 * Reads: config/outreach.yml
 * Uses:  outreach-db.mjs (SQLite via better-sqlite3)
 * Stores: persistent Chrome session in outreach-chrome/
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  getLeadsByStatus,
  updateStatus,
  getTodaySendCount,
  closeDb,
} from './outreach-db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadConfig() {
  const outreachPath = join(__dirname, 'config', 'outreach.yml');
  if (!existsSync(outreachPath)) {
    throw new Error('config/outreach.yml not found. Run setup first.');
  }
  return yaml.load(readFileSync(outreachPath, 'utf-8'));
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
  console.log(`  Waiting ${Math.round(ms / 1000)}s before next send...`);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Login mode
// ---------------------------------------------------------------------------

async function loginMode(chromeDataDir) {
  // Ensure chrome data directory exists
  if (!existsSync(chromeDataDir)) {
    mkdirSync(chromeDataDir, { recursive: true });
    console.log(`Created chrome data directory: ${chromeDataDir}`);
  }

  console.log('Opening LinkedIn login page...');
  console.log('Please log in manually in the browser window, then close it when done.');

  const context = await chromium.launchPersistentContext(chromeDataDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.linkedin.com/login');

  // Wait for the browser window to be closed by the user
  await new Promise((resolve) => {
    context.on('close', resolve);
  });

  console.log('Browser closed. LinkedIn session saved to:', chromeDataDir);
}

// ---------------------------------------------------------------------------
// Send mode
// ---------------------------------------------------------------------------

async function sendMode(config, dryRun) {
  const maxPerDay = config.linkedin?.max_sends_per_day ?? 10;
  const delayRange = config.linkedin?.delay_between_sends ?? [30, 90];
  const chromeDataDir = resolve(__dirname, config.linkedin?.chrome_data ?? './outreach-chrome');

  // Check daily send limit
  const todaySent = getTodaySendCount();
  const remaining = maxPerDay - todaySent;

  if (remaining <= 0) {
    console.log(`Daily send limit reached (${todaySent}/${maxPerDay} sent today). Try again tomorrow.`);
    closeDb();
    return;
  }

  console.log(`Daily quota: ${todaySent} sent today, ${remaining} remaining (limit: ${maxPerDay})`);

  // Get approved leads
  const allApproved = getLeadsByStatus('approved');

  if (allApproved.length === 0) {
    console.log('No approved leads to send. Approve some leads first (node outreach.mjs review).');
    closeDb();
    return;
  }

  // Slice to remaining daily quota
  const toSend = allApproved.slice(0, remaining);

  if (dryRun) {
    console.log(`\n[DRY RUN] Would send ${toSend.length} connection request(s):\n`);
    for (const lead of toSend) {
      console.log(`  - ${lead.name ?? lead.profile_url}`);
      console.log(`    URL:  ${lead.profile_url}`);
      console.log(`    Note: ${lead.connection_note ?? '(no note)'}`);
      console.log();
    }
    closeDb();
    return;
  }

  // Ensure chrome data directory exists
  if (!existsSync(chromeDataDir)) {
    mkdirSync(chromeDataDir, { recursive: true });
  }

  // Launch persistent context
  console.log(`Launching browser (persistent context: ${chromeDataDir})...`);
  const context = await chromium.launchPersistentContext(chromeDataDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    // Verify LinkedIn login
    const verifyPage = context.pages()[0] || await context.newPage();
    await verifyPage.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
    const currentUrl = verifyPage.url();

    if (
      currentUrl.includes('/login') ||
      currentUrl.includes('/signup') ||
      currentUrl.includes('/authwall')
    ) {
      console.error('Not logged in to LinkedIn. Run: node send-outreach.mjs --login');
      await context.close();
      closeDb();
      process.exit(1);
    }

    console.log(`Logged in. Sending ${toSend.length} connection request(s)...\n`);

    let rateLimited = false;

    for (let i = 0; i < toSend.length; i++) {
      const lead = toSend[i];
      const label = lead.name ?? lead.profile_url;

      if (rateLimited) {
        console.log(`Skipping ${label} (rate limited — halting remaining sends)`);
        break;
      }

      console.log(`[${i + 1}/${toSend.length}] Sending to: ${label}`);
      console.log(`  Profile: ${lead.profile_url}`);

      try {
        const page = await context.newPage();
        await page.goto(lead.profile_url, { waitUntil: 'domcontentloaded' });

        // --- Find and click the Connect button ---
        let connected = false;

        // 1) Try main-action Connect button
        const connectBtn = page.locator('button:has-text("Connect")').first();
        if (await connectBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await connectBtn.click();
          connected = true;
        }

        // 2) Try "More" dropdown if no direct Connect button
        if (!connected) {
          const moreBtn = page.locator('button:has-text("More")').first();
          if (await moreBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await moreBtn.click();
            await page.waitForTimeout(500);
            const dropdownConnect = page.locator('[role="menuitem"]:has-text("Connect")').first();
            if (await dropdownConnect.isVisible({ timeout: 2000 }).catch(() => false)) {
              await dropdownConnect.click();
              connected = true;
            }
          }
        }

        if (!connected) {
          console.log(`  Could not find Connect button for ${label} — skipping`);
          updateStatus(lead.profile_url, 'send_failed', 'Connect button not found');
          await page.close();
          continue;
        }

        // --- Check for rate limit modal ---
        await page.waitForTimeout(800);
        const rateLimitModal = page.locator('text=/weekly invitation limit|invitation limit reached/i').first();
        if (await rateLimitModal.isVisible({ timeout: 1500 }).catch(() => false)) {
          console.log('  Rate limit modal detected — halting all remaining sends.');
          updateStatus(lead.profile_url, 'send_failed', 'LinkedIn rate limit reached');
          await page.close();
          rateLimited = true;
          continue;
        }

        // --- Add a note if field is present ---
        const addNoteBtn = page.locator('button:has-text("Add a note")').first();
        if (await addNoteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await addNoteBtn.click();
          await page.waitForTimeout(500);

          const textarea = page.locator('textarea[name="message"]').first();
          if (await textarea.isVisible({ timeout: 2000 }).catch(() => false) && lead.connection_note) {
            await textarea.fill(lead.connection_note);
          }
        }

        // --- Click Send ---
        const sendBtn = page.locator('button:has-text("Send")').first();
        if (await sendBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await sendBtn.click();
          await page.waitForTimeout(1000);

          // Final rate limit check after send
          const postSendRateLimit = page.locator('text=/weekly invitation limit|invitation limit reached/i').first();
          if (await postSendRateLimit.isVisible({ timeout: 1500 }).catch(() => false)) {
            console.log('  Rate limit detected after send attempt — halting.');
            updateStatus(lead.profile_url, 'send_failed', 'LinkedIn rate limit reached after send');
            await page.close();
            rateLimited = true;
            continue;
          }

          updateStatus(lead.profile_url, 'sent');
          console.log(`  Sent successfully.`);
        } else {
          console.log(`  Send button not found for ${label} — marking as failed`);
          updateStatus(lead.profile_url, 'send_failed', 'Send button not found');
        }

        await page.close();
      } catch (err) {
        console.error(`  Error sending to ${label}:`, err.message);
        updateStatus(lead.profile_url, 'send_failed', err.message);
      }

      // Delay between sends (skip after the last one)
      if (i < toSend.length - 1 && !rateLimited) {
        await randomDelay(delayRange[0], delayRange[1]);
      }
    }

    console.log('\nDone.');
  } finally {
    await context.close();
    closeDb();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const isLogin = args.includes('--login');
  const isDryRun = args.includes('--dry-run');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('Config error:', err.message);
    process.exit(1);
  }

  const chromeDataDir = resolve(__dirname, config.linkedin?.chrome_data ?? './outreach-chrome');

  if (isLogin) {
    await loginMode(chromeDataDir);
  } else {
    await sendMode(config, isDryRun);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  closeDb();
  process.exit(1);
});
