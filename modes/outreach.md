# Mode: outreach -- Startup Leader Outreach Pipeline

Find CEOs/CTOs of startups that align with your profile, draft personalized LinkedIn connection notes, and send them after your review.

---

## Sub-commands

| Command | Description |
|---------|-------------|
| `/career-ops outreach` | Review pending drafts (approve, edit, skip) |
| `/career-ops outreach scan` | Run a new scout pipeline (includes email discovery) |
| `/career-ops outreach login` | Open browser for LinkedIn login |
| `/career-ops outreach status` | Show pipeline stats (LinkedIn + email) |
| `/career-ops outreach config` | Show/edit outreach.yml |
| `/career-ops outreach send-emails` | Send emails to approved leads |

---

## Prerequisites

Before any outreach workflow, verify:

1. `outreach.yml` exists with a valid `nexus_path` pointing to your Nexus-HeadHunter installation
2. Nexus-HeadHunter is installed at that path with `bridge/` scripts present
3. LinkedIn session is active (run `login` if not)
4. `GROQ_API_KEY` environment variable is set

If any prerequisite is missing, tell the user what's needed before proceeding.

---

## Workflows

### Scan (`/career-ops outreach scan`)

Run a new scout pipeline to find and qualify startup leaders.

```bash
node outreach.mjs scan
```

Report the results: how many leads found, how many qualified, how many emails discovered, how many connection notes drafted. Offer to start the review flow immediately.

---

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

### Review (`/career-ops outreach` — default)

Load pending drafts for user approval.

```bash
node outreach.mjs review
```

This returns JSON. For each lead, present:

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

Warn if `char_count` exceeds 300 (LinkedIn hard limit).
Flag if the company already appears in `data/applications.md` with status `Applied` or later.

User actions (present as a menu after each lead):
- **[a] Approve** — mark as approved, move to next
- **[e] Edit** — Claude presents the note and the user dictates changes; Claude rewrites it and shows the result for confirmation before saving
- **[s] Skip** — skip this lead (do not send, do not discard)
- **[q] Quit** — stop review, save progress

After all leads are reviewed (or user quits), show a summary:

```
Review complete: {approved} approved, {skipped} skipped, {edited} edited.
```

Then ask: "Send {approved} approved connection requests now? [y/n]"

If yes, run the sender:

```bash
node send-outreach.mjs
```

If no, tell the user they can send later by running `/career-ops outreach` again once ready.

---

### Login (`/career-ops outreach login`)

Open a browser window for LinkedIn authentication.

```bash
node send-outreach.mjs --login
```

Guide the user to log in manually. The session cookie will be saved for future sends. Confirm success once the browser closes.

---

### Status (`/career-ops outreach status`)

Show pipeline statistics.

```bash
node outreach.mjs status
```

Display the output as-is. If the command returns JSON, format it as a readable summary table.

---

### Config (`/career-ops outreach config`)

Read `outreach.yml` and display its current settings. Offer to edit any field. Common edits:
- `nexus_path` — path to Nexus-HeadHunter
- `daily_limit` — max sends per day (default: 10)
- `min_delay_seconds` / `max_delay_seconds` — send pacing
- `target_roles` — which founder titles to target
- `filters` — company size, industry, funding stage filters

If the user requests changes, edit `outreach.yml` directly and confirm.

---

## Review Rules

- **NEVER send without explicit user approval.** Every note must be reviewed before sending.
- Show character count on every note. LinkedIn caps connection notes at 300 characters.
- Warn clearly if a note exceeds 300 characters — it will be rejected by LinkedIn.
- Flag leads whose company is already in `data/applications.md` with status `Applied`, `Interview`, `Offer`, or `Rejected`. The user may want to skip these to avoid mixed signals.

---

## Safety

- Maximum 10 connection requests per day (configurable in `outreach.yml`)
- Random delay of 30-90 seconds between sends to mimic human pacing
- If LinkedIn returns a rate limit signal, halt immediately and tell the user how many were sent before the limit was hit
- Always verify LinkedIn session is active before attempting sends (`node send-outreach.mjs --login` if session is stale)
- Do not retry failed sends automatically — report failures and let the user decide
- Maximum 15 emails per day (configurable in `outreach.yml` under `email.max_sends_per_day`)
- Random delay of 3-8 minutes between email sends
- Plain text only emails (no HTML, reduces spam score)
- Stop immediately on any Gmail authentication error
- Emails use the same approval gate as LinkedIn -- no email is sent without user approval
