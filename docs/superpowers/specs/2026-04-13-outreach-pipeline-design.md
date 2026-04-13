# Outreach Pipeline Design — career-ops x Nexus-HeadHunter

**Date:** 2026-04-13
**Status:** Approved
**Author:** Yuvraj Singh + Claude

## Summary

A recurring LinkedIn outreach pipeline that discovers startup CEOs/CTOs aligned with Yuvraj's profile, enriches their profiles, drafts personalized connection notes, and sends them after human review. Career-ops orchestrates the pipeline and owns the UX; Nexus-HeadHunter provides the Scout, Investigator, and Copywriter agents via subprocess bridge.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Discovery source | LinkedIn only | Sufficient for startup leader discovery |
| Trigger | Recurring (every N days) | Passive lead generation without manual effort |
| Architecture | Thin bridge (Approach 1) | Reuse working Nexus Python agents, ship fast |
| Review UX | Terminal-based | Consistent with career-ops workflow |
| Chrome profile | Separate from Nexus | Avoids conflicts if both tools run simultaneously |

## Architecture

```
career-ops                              Nexus-HeadHunter
-----------------                       -----------------

 profile.yml  --+
 _profile.md  --+
 cv.md        --+--> outreach.mjs ------> Scout (LinkedIn)
                     |                      |
                     |   JSON stdin/stdout   |
                     |                      v
                     |               Investigator (enrich + RAG)
                     |                      |
                     |                      v
                     |               Copywriter (Groq LLM)
                     |                      |
                     <----------------------+
                     |
                     v
               outreach.db (SQLite)
                     |
                     v
               Terminal review (approve/edit/skip)
                     |
                     v
               send-outreach.mjs (Playwright)
                     |  own outreach-chrome/
                     v
               LinkedIn connection + message
```

**Flow:**
1. `outreach.mjs` reads career-ops profile and generates a search query from archetypes
2. Calls Nexus Scout via subprocess -- returns raw leads as JSON
3. Calls Nexus Investigator for each lead -- returns enriched profiles
4. Calls Nexus Copywriter with career-ops proof points injected -- returns personalized drafts
5. Stores everything in `outreach.db` (SQLite)
6. Presents leads + drafts in terminal for review
7. Approved messages sent by `send-outreach.mjs` using Playwright with its own Chrome profile

## File Structure

### New files in career-ops

```
career-ops/
├── outreach.mjs              # Main orchestrator
├── send-outreach.mjs         # Playwright sender
├── outreach-query-gen.mjs    # Generates search queries from profile
├── data/
│   └── outreach.db           # SQLite lead storage (gitignored)
├── outreach-chrome/          # Persistent Chrome profile (gitignored)
├── config/
│   └── outreach.yml          # Search criteria, schedule, Nexus path
├── modes/
│   └── outreach.md           # Mode file for /career-ops outreach
```

### New files in Nexus-HeadHunter

```
Nexus-HeadHunter/
├── bridge/
│   ├── scout_bridge.py         # search params JSON -> leads[] JSON
│   ├── investigator_bridge.py  # lead JSON -> enriched lead JSON
│   └── copywriter_bridge.py    # enriched lead + resume -> drafts JSON
```

### Gitignore additions (career-ops)

```
outreach-chrome/
data/outreach.db
```

## Nexus Bridge Interface

Each bridge script is a thin wrapper that imports from Nexus's existing agent code, accepts JSON on stdin, and returns JSON on stdout.

### Scout Bridge

**stdin:**
```json
{
  "query": "CTO AI startup remote",
  "max_pages": 2,
  "chrome_data": "/home/13843K/Desktop/mygitprojects/Nexus-HeadHunter/chrome_data"
}
```

**stdout:**
```json
{
  "leads": [
    {
      "name": "Jane Doe",
      "headline": "CTO @ BuildAI",
      "profile_url": "https://linkedin.com/in/janedoe",
      "location": "Remote"
    }
  ]
}
```

### Investigator Bridge

**stdin:**
```json
{
  "lead": {"name": "Jane Doe", "profile_url": "https://linkedin.com/in/janedoe"},
  "resume_text": "Yuvraj Singh -- AI Engineer who ships production agentic systems...",
  "chrome_data": "/home/13843K/Desktop/mygitprojects/Nexus-HeadHunter/chrome_data"
}
```

**stdout:**
```json
{
  "about": "Building AI infrastructure...",
  "experience": ["CTO @ BuildAI (2023-present)"],
  "recent_posts": ["Just shipped our agent framework..."],
  "email_guesses": ["jane@buildai.com", "j.doe@buildai.com"],
  "rag_hook": "I see you're scaling agent infrastructure -- I built a self-healing RPA engine with 85% autonomous success rate"
}
```

### Copywriter Bridge

**stdin:**
```json
{
  "lead": {"name": "Jane Doe", "headline": "CTO @ BuildAI"},
  "enrichment": {
    "about": "...",
    "recent_posts": ["..."],
    "rag_hook": "..."
  },
  "candidate": {
    "name": "Yuvraj Singh",
    "headline": "AI Engineer -- agentic systems, AR, real-time backends",
    "proof_points": [
      "OBLIS: 45% repeat visit reduction, 30L savings",
      "Self-Healing RPA: 85% success rate"
    ],
    "target_role": "AI Engineer"
  }
}
```

**stdout:**
```json
{
  "connection_note": "Your post on agent orchestration resonated -- I built a self-healing RPA engine that handles dynamic sites at 85% success. Would love to connect.",
  "email_subject": "Agent systems at BuildAI",
  "email_body": "Hi Jane, ..."
}
```

## Terminal Review UX

When `/career-ops outreach` is run or the recurring scan surfaces new leads:

```
+--------------------------------------------------------------+
|  Outreach Queue -- 7 new drafts ready for review             |
+--------------------------------------------------------------+

--- Lead 1/7 -------------------------------------------------

  Jane Doe -- CTO @ BuildAI
  Location: San Francisco (Remote-friendly)
  Headline: "Building agent infrastructure for the next wave of AI apps"
  Recent post: "Just shipped our multi-agent orchestration framework..."
  RAG match: agentic systems, orchestration

  Connection Note (278 chars):
  +-----------------------------------------------------------+
  | Your post on agent orchestration resonated -- I built a    |
  | self-healing RPA engine that handles dynamic sites at      |
  | 85% success. Would love to connect.                        |
  +-----------------------------------------------------------+

  [a] Approve   [e] Edit message   [s] Skip   [q] Quit review
```

**Actions:**
- `a` -- approve, mark as `approved` in db, next lead
- `e` -- Claude presents the message, user dictates changes, Claude updates and re-presents for approval
- `s` -- mark as `skipped`, next lead
- `q` -- exit review, remaining leads stay as `drafted`

**After review:**
```
Review complete: 5 approved, 1 edited, 1 skipped

Send 5 approved messages now? [y/n]
```

If yes: `send-outreach.mjs` opens Playwright, sends each connection request with note, marks as `sent`. Human-like delays (30-90s random) between sends.

## Config: outreach.yml

```yaml
nexus_path: "/home/13843K/Desktop/mygitprojects/Nexus-HeadHunter"

schedule:
  interval_days: 3
  max_leads_per_run: 15

search:
  queries:
    - "CTO AI startup remote"
    - "Founder agentic AI company"
    - "CTO machine learning startup India remote"
  title_filter:
    - CTO
    - CEO
    - Founder
    - "Head of Engineering"
    - "VP Engineering"
  exclude_companies: []

linkedin:
  chrome_data: "./outreach-chrome"
  max_sends_per_day: 10
  delay_between_sends: [30, 90]
```

**Auto-query generation:** `outreach-query-gen.mjs` reads `profile.yml` archetypes and target roles, crosses them with title filters, and generates search queries. Manual overrides in config take precedence.

## Deduplication

Before presenting new leads, check against three sources:

1. **`outreach.db`** -- already contacted, skipped, or in-progress
2. **`data/applications.md`** -- already applied to that company. Flag with: `"Already applied to BuildAI (Report #042, Score 4.2/5)"` -- user can still reach out with context
3. **Nexus `nexus.db`** -- already found by Nexus in standalone use

Unique key: LinkedIn profile URL.

## SQLite Schema (outreach.db)

```sql
CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_url TEXT UNIQUE NOT NULL,
  name TEXT,
  headline TEXT,
  company TEXT,
  location TEXT,
  about TEXT,
  experience TEXT,          -- JSON array
  recent_posts TEXT,        -- JSON array
  email_guesses TEXT,       -- JSON array
  rag_hook TEXT,
  connection_note TEXT,
  email_subject TEXT,
  email_body TEXT,
  status TEXT DEFAULT 'found',  -- found|enriched|drafted|approved|skipped|sent|send_failed|unreachable
  source_query TEXT,
  discovered_at TEXT,       -- ISO timestamp
  enriched_at TEXT,
  drafted_at TEXT,
  sent_at TEXT,
  error TEXT                -- error message if failed
);
```

## LinkedIn Safety

**Rate limiting:**
- Max 10 connection requests per day (configurable)
- Random delay 30-90 seconds between sends
- If daily limit reached mid-queue, remaining stay as `approved` for next day
- Scout scraping: max 2 pages per query per run (~20 leads)

**Session management:**
- First run: `send-outreach.mjs --login` opens Playwright headed mode for manual LinkedIn login. Session persists in `outreach-chrome/`.
- Session expiry: script pauses and prompts to re-authenticate
- Session check runs before any send batch

**Error handling:**

| Stage | Failure | Behavior |
|-------|---------|----------|
| Scout subprocess | Nexus not found / Python error | Log error, suggest checking `nexus_path`. No leads = no pipeline. |
| Investigator | Profile scrape fails | Mark lead as `unreachable`, skip to next |
| Copywriter | Groq API error | Retry once. If fails, mark as `draft_failed`, continue |
| Send | Connection button not found | Mark as `send_failed` with reason |
| Send | LinkedIn rate limit warning | Halt all sends, mark remaining as `approved` for next day |

**Data safety:**
- `outreach.db` gitignored -- no personal LinkedIn data in repo
- `outreach-chrome/` gitignored -- no session cookies in repo
- Groq API key from env var `GROQ_API_KEY`, never stored in config

## Mode Integration

### CLAUDE.md additions

Add to the skill mode routing table:
```
| Asks to find and message startup leaders | `outreach` |
```

Add to available commands in discovery mode:
```
/career-ops outreach  -> Find startup leaders, draft messages, send LinkedIn connections
```

### modes/outreach.md

Sub-commands:
- `/career-ops outreach` -- review pending drafts, send approved
- `/career-ops outreach scan` -- trigger a new scout run (outside schedule)
- `/career-ops outreach login` -- open Playwright for LinkedIn login
- `/career-ops outreach status` -- show stats (leads found, sent, response rate)
- `/career-ops outreach config` -- show/edit outreach.yml

### npm scripts

```json
{
  "outreach": "node outreach.mjs",
  "outreach:send": "node send-outreach.mjs",
  "outreach:login": "node send-outreach.mjs --login",
  "outreach:query": "node outreach-query-gen.mjs"
}
```

## Out of Scope

- Email sending (LinkedIn connections only for v1)
- Wellfound / other platform discovery
- Streamlit or web dashboard
- Go TUI dashboard integration (can be added later)
- Automated follow-up messages (v2)
