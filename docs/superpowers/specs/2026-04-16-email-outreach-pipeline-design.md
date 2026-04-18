# Email Outreach Pipeline Design

**Date:** 2026-04-16
**Status:** Approved
**Scope:** Add email discovery and sending to the existing outreach pipeline

## Overview

Extend the career-ops outreach pipeline with email discovery (pattern guessing + SMTP verification) and sending (Gmail SMTP via nodemailer). Targets: HRs, CTOs, CEOs, and other decision-makers already discovered through the LinkedIn Scout pipeline.

## Architecture

The email pipeline slots into the existing outreach flow as two new stages:

```
Scout → Enrich → [Email Discover] → Draft → Approve → [Send Email + LinkedIn]
                  ^^^^ NEW                              ^^^^ EXTENDED
```

- `email-discover.mjs` — runs after enrichment, before drafting
- `send-email.mjs` — runs alongside `send-outreach.mjs` (LinkedIn), shares the approval gate

### Database Changes (existing `leads` table)

Add three columns:
- `verified_email` TEXT — the best verified email address (nullable)
- `email_status` TEXT — `pending` | `verified` | `unverifiable` | `sent` | `bounced`
- `email_sent_at` TEXT — ISO timestamp of when email was sent

No new tables. Everything stays in the existing `leads` table in `data/outreach.db`.

## Email Discovery (`email-discover.mjs`)

**Input:** Enriched leads from SQLite where `email_status` is null or `pending`.

**Discovery pipeline per lead:**

1. **Harvest existing guesses** — Pull `email_guesses` already extracted by Nexus-HeadHunter investigator bridge
2. **Extract company domain** — Parse the lead's company LinkedIn URL or website from enrichment data. Fallback: Google the company name + "site" to find their domain
3. **Generate patterns** — From `name` + `domain`, create candidates ranked by probability:
   - `first.last@domain.com` (~60% of companies)
   - `first@domain.com`
   - `flast@domain.com`
   - `firstl@domain.com`
   - `first_last@domain.com`
   - `last@domain.com`
4. **Verify via DNS + SMTP:**
   - Check domain has MX records (no MX → skip)
   - Catch-all detection: RCPT TO for a random gibberish address — if accepted, server accepts everything, mark patterns as `unverifiable` but keep the most probable one
   - For non-catch-all: SMTP RCPT TO each pattern. First 250 OK → `verified_email`
5. **Merge & deduplicate** — Combine Nexus guesses with pattern results. Best verified address wins.

**Rate limiting:** Max 2 SMTP checks per second. Rotate through leads to avoid hammering one domain.

**Output:** Updates `verified_email` and `email_status` in SQLite.

**CLI:**
```bash
node email-discover.mjs                  # discover for all enriched leads
node email-discover.mjs --dry-run        # show what would be checked
node email-discover.mjs --lead <id>      # single lead
```

## Email Sending (`send-email.mjs`)

**Input:** Approved leads where `verified_email` is not null and `email_status` is `verified`.

**Sending mechanics:**
- `nodemailer` with Gmail SMTP (`smtp.gmail.com:587`, TLS)
- Authenticates with Gmail + App Password from `config/outreach.yml`
- Sends as `{candidate.full_name} <{candidate.email}>` from `config/profile.yml`

**Email composition per lead:**
- **Subject:** Short, personalized — e.g. "AI Engineer → [Company]" or reference to recent activity
- **Body structure:**
  1. **Hook** (1-2 lines) — Reference something specific from `recent_posts` or `experience` in enriched data
  2. **Bridge** (1-2 lines) — Who you are + what you build from `profile.yml` narrative/superpowers
  3. **Ask** (1 line) — Direct: "Are you hiring for [role]?" or "Would love to chat about [specific thing]"
  4. **Sign-off** — Name, LinkedIn, portfolio URL from profile.yml
- **Plain text only** — No HTML (lower spam score for cold emails)
- Draft content comes from the existing `copywriter_bridge.py` output (`email_subject` + `email_body`)

**Rate limiting:**
- Max 15 emails/day (configurable)
- Random delay between sends: 3-8 minutes
- Stops on any Gmail error (auth failure, rate limit)
- Tracks daily count via `email_sent_at` timestamps in SQLite

**CLI:**
```bash
node send-email.mjs                # send approved leads with verified emails
node send-email.mjs --dry-run      # preview emails that would be sent
node send-email.mjs --limit 5      # send max 5 this run
```

**Setup:** If `app_password` is empty, script exits with setup instructions:
```
Email sending requires a Gmail App Password.
1. Go to myaccount.google.com/apppasswords
2. Generate a password for "Mail"
3. Paste it into config/outreach.yml under email.app_password
```

## Integration with Existing Pipeline

### `outreach.mjs` changes

The `scan` command flow becomes:
```
node outreach.mjs scan
  1. Scout (find leads on LinkedIn)        ← existing
  2. Enrich (scrape profiles)              ← existing
  3. Email Discover (find + verify emails) ← NEW
  4. Draft (connection note + email)       ← existing
```

### `review` command changes

Extended to show email channel alongside LinkedIn:
```json
{
  "name": "Jane Doe",
  "headline": "CTO at Acme",
  "connection_note": "Hi Jane, loved your talk on...",
  "verified_email": "jane.doe@acme.com",
  "email_subject": "AI Engineer → Acme",
  "email_body": "Hi Jane, saw your recent post about...",
  "channels": ["linkedin", "email"]
}
```

Approving a lead queues both LinkedIn request and email.

### `status` command changes

Adds email stats:
```json
{
  "linkedin": { "sent": 12, "pending": 5 },
  "email": { "verified": 8, "unverifiable": 4, "sent": 6, "pending": 2 }
}
```

### New subcommand

```bash
node outreach.mjs send-emails    # shortcut for node send-email.mjs
```

## Configuration

**`config/outreach.yml` additions:**

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

**Security:** App Password is the only secret. Never logged, never committed. Script validates it exists before attempting sends.

## File Changes Summary

**New files (2):**
| File | Purpose |
|------|---------|
| `email-discover.mjs` | Pattern generation + DNS/SMTP verification |
| `send-email.mjs` | Gmail SMTP sender with rate limiting |

**Modified files (5):**
| File | Change |
|------|--------|
| `outreach-db.mjs` | Add `verified_email`, `email_status`, `email_sent_at` columns + helper functions |
| `outreach.mjs` | Insert email discovery into `scan`, add `send-emails` subcommand, extend `review`/`status` |
| `config/outreach.yml` | Add `email:` config block |
| `modes/outreach.md` | Document email stages in workflow instructions |
| `package.json` | Add `nodemailer` dependency + `outreach:email` npm script |

**Dependencies:** `nodemailer` (only new dep). DNS and SMTP checks use Node built-in `dns` and `net` modules.

## Out of Scope

- Follow-up email sequences
- HTML email templates
- Bounce tracking beyond Gmail errors
- Alternative email providers (Resend, Mailgun, etc.)
- Email open/click tracking
