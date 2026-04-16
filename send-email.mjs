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
