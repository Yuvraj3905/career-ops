# Outreach Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a recurring LinkedIn outreach pipeline that discovers startup CEOs/CTOs via Nexus-HeadHunter's Python agents, presents drafts for terminal review, and sends approved connection requests via Playwright.

**Architecture:** Career-ops (Node.js) orchestrates the pipeline — generates search queries from profile, calls Nexus-HeadHunter (Python) agents via JSON stdin/stdout subprocess bridge, stores leads in SQLite, and handles review UX + LinkedIn sending with its own Playwright/Chrome profile.

**Tech Stack:** Node.js (ESM .mjs), better-sqlite3, Playwright, js-yaml, Python subprocess bridge to Nexus-HeadHunter (LangGraph agents, Groq LLM, FAISS RAG)

**Spec:** `docs/superpowers/specs/2026-04-13-outreach-pipeline-design.md`

---

### Task 1: Nexus-HeadHunter Bridge Scripts (Python)

Three thin wrappers that accept JSON on stdin and return JSON on stdout. They live in `Nexus-HeadHunter/bridge/` and import from the existing agent code.

**Files:**
- Create: `/home/13843K/Desktop/mygitprojects/Nexus-HeadHunter/bridge/__init__.py`
- Create: `/home/13843K/Desktop/mygitprojects/Nexus-HeadHunter/bridge/scout_bridge.py`
- Create: `/home/13843K/Desktop/mygitprojects/Nexus-HeadHunter/bridge/investigator_bridge.py`
- Create: `/home/13843K/Desktop/mygitprojects/Nexus-HeadHunter/bridge/copywriter_bridge.py`

- [ ] **Step 1: Create bridge directory and __init__.py**

```bash
mkdir -p /home/13843K/Desktop/mygitprojects/Nexus-HeadHunter/bridge
touch /home/13843K/Desktop/mygitprojects/Nexus-HeadHunter/bridge/__init__.py
```

- [ ] **Step 2: Create scout_bridge.py**

```python
#!/usr/bin/env python3
"""Bridge: JSON stdin -> Scout agent -> JSON stdout.

Input:  {"query": "CTO AI startup remote", "max_pages": 2, "chrome_data": "/path/to/chrome_data"}
Output: {"leads": [{"name": "...", "headline": "...", "profile_url": "...", "company": "...", "location": "..."}]}
Error:  {"error": "message"}
"""
import json
import sys
import os

# Add parent dir to path so we can import from agents/tools
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agents.scout import parse_search_query, build_linkedin_search_url, extract_leads_from_page
from tools.browser import HumanBrowser
from tools.database import is_lead_exists


def main():
    try:
        params = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    query = params.get("query", "")
    max_pages = params.get("max_pages", 2)
    chrome_data = params.get("chrome_data", os.path.join(os.getcwd(), "chrome_data"))

    if not query:
        print(json.dumps({"error": "Missing 'query' field"}))
        sys.exit(1)

    try:
        search_params = parse_search_query(query)
        search_url = build_linkedin_search_url(search_params, query)

        all_leads = []
        with HumanBrowser(headless=False) as browser:
            # Override chrome data dir
            browser.user_data_dir = chrome_data
            browser.navigate(search_url)

            if not browser.is_logged_in():
                print(json.dumps({"error": "Not logged into LinkedIn. Run login flow first."}))
                sys.exit(1)

            for page_num in range(max_pages):
                leads = extract_leads_from_page(browser, limit=10)
                for lead in leads:
                    if not is_lead_exists(lead["profile_url"]):
                        all_leads.append(lead)

                # Try next page
                if page_num < max_pages - 1:
                    try:
                        next_btn = browser.page.query_selector('button[aria-label="Next"]')
                        if next_btn:
                            next_btn.click()
                            browser.human_delay(3, 6)
                        else:
                            break
                    except Exception:
                        break

        print(json.dumps({"leads": all_leads}))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Create investigator_bridge.py**

```python
#!/usr/bin/env python3
"""Bridge: JSON stdin -> Investigator enrichment -> JSON stdout.

Input:  {"lead": {"name": "...", "profile_url": "..."}, "resume_text": "...", "chrome_data": "/path"}
Output: {"about": "...", "experience": [...], "recent_posts": [...], "email_guesses": [...], "rag_hook": "..."}
Error:  {"error": "message"}
"""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.browser import HumanBrowser
from tools.email_finder import generate_email_permutations
from tools.rag import ResumeRAG
from agents.investigator import scrape_profile_details


def main():
    try:
        params = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    lead = params.get("lead", {})
    resume_text = params.get("resume_text", "")
    chrome_data = params.get("chrome_data", os.path.join(os.getcwd(), "chrome_data"))

    profile_url = lead.get("profile_url", "")
    if not profile_url:
        print(json.dumps({"error": "Missing lead.profile_url"}))
        sys.exit(1)

    try:
        # Scrape profile
        with HumanBrowser(headless=False) as browser:
            browser.user_data_dir = chrome_data
            details = scrape_profile_details(browser, profile_url)

        about = details.get("about", "")
        experience_text = details.get("experience", "")
        recent_posts = details.get("recent_posts", [])

        # Generate email guesses
        name_parts = lead.get("name", "").split()
        company = lead.get("company", "")
        email_guesses = []
        if len(name_parts) >= 2 and company:
            first = name_parts[0]
            last = name_parts[-1]
            # Guess domain from company name
            domain = company.lower().replace(" ", "") + ".com"
            email_guesses = generate_email_permutations(first, last, domain)

        # RAG hook
        rag_hook = ""
        if resume_text:
            rag = ResumeRAG()
            rag.load_resume(resume_text)
            target_content = f"{lead.get('headline', '')} {about} {' '.join(recent_posts)}"
            relevant = rag.find_relevant_experience(target_content)
            rag_hook = rag.generate_hook(target_content, relevant)

        result = {
            "about": about,
            "experience": [experience_text] if experience_text else [],
            "recent_posts": recent_posts,
            "email_guesses": email_guesses[:4],
            "rag_hook": rag_hook,
        }
        print(json.dumps(result))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Create copywriter_bridge.py**

```python
#!/usr/bin/env python3
"""Bridge: JSON stdin -> Copywriter agent -> JSON stdout.

Input:  {"lead": {...}, "enrichment": {...}, "candidate": {"name": "...", "headline": "...", "proof_points": [...], "target_role": "..."}}
Output: {"connection_note": "...", "email_subject": "...", "email_body": "..."}
Error:  {"error": "message"}
"""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agents.copywriter import draft_message_for_lead, get_llm


def main():
    try:
        params = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    lead = params.get("lead", {})
    enrichment = params.get("enrichment", {})
    candidate = params.get("candidate", {})

    if not lead.get("name"):
        print(json.dumps({"error": "Missing lead.name"}))
        sys.exit(1)

    try:
        # Build enriched lead structure expected by copywriter
        enriched_lead = {
            "name": lead.get("name", ""),
            "headline": lead.get("headline", ""),
            "profile_url": lead.get("profile_url", ""),
            "company": lead.get("company", ""),
            "location": lead.get("location", ""),
            "about": enrichment.get("about", ""),
            "recent_posts": enrichment.get("recent_posts", []),
            "emails": enrichment.get("email_guesses", []),
            "hook": enrichment.get("rag_hook", ""),
        }

        # Build resume summary from candidate info
        resume_summary = f"{candidate.get('name', '')} -- {candidate.get('headline', '')}\n"
        for pp in candidate.get("proof_points", []):
            resume_summary += f"- {pp}\n"

        target_role = candidate.get("target_role", "AI Engineer")

        llm = get_llm()
        draft = draft_message_for_lead(enriched_lead, resume_summary, target_role, llm)

        result = {
            "connection_note": draft.get("connection_note", ""),
            "email_subject": draft.get("email_subject", ""),
            "email_body": draft.get("email_body", ""),
        }
        print(json.dumps(result))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Test each bridge script with dry-run input**

Test scout bridge parses input correctly (it will fail on LinkedIn login, but should parse JSON and reach the browser step):
```bash
cd /home/13843K/Desktop/mygitprojects/Nexus-HeadHunter
echo '{"query": "CTO AI startup", "max_pages": 1}' | python3 bridge/scout_bridge.py
```
Expected: Either `{"leads": [...]}` or `{"error": "Not logged into LinkedIn..."}` (valid error, not a crash).

Test copywriter bridge with mock input (requires GROQ_API_KEY):
```bash
echo '{"lead": {"name": "Test"}, "enrichment": {}, "candidate": {"name": "Yuvraj", "headline": "AI Engineer", "proof_points": [], "target_role": "AI Engineer"}}' | python3 bridge/copywriter_bridge.py
```
Expected: JSON output with `connection_note`, `email_subject`, `email_body` keys.

- [ ] **Step 6: Commit bridge scripts**

```bash
cd /home/13843K/Desktop/mygitprojects/Nexus-HeadHunter
git add bridge/
git commit -m "feat: add bridge scripts for career-ops integration

JSON stdin/stdout wrappers for Scout, Investigator, and Copywriter
agents. Enables career-ops to call Nexus agents via subprocess."
```

---

### Task 2: Career-ops Project Setup

Install dependencies, update gitignore, create config file.

**Files:**
- Modify: `/home/13843K/Desktop/mygitprojects/career-ops/package.json`
- Modify: `/home/13843K/Desktop/mygitprojects/career-ops/.gitignore`
- Create: `/home/13843K/Desktop/mygitprojects/career-ops/config/outreach.yml`

- [ ] **Step 1: Install better-sqlite3**

```bash
cd /home/13843K/Desktop/mygitprojects/career-ops
npm install better-sqlite3
```

- [ ] **Step 2: Add npm scripts to package.json**

Add these to the `"scripts"` section:
```json
{
  "outreach": "node outreach.mjs",
  "outreach:send": "node send-outreach.mjs",
  "outreach:login": "node send-outreach.mjs --login",
  "outreach:query": "node outreach-query-gen.mjs"
}
```

- [ ] **Step 3: Update .gitignore**

Append to `.gitignore`:
```
outreach-chrome/
data/outreach.db
```

- [ ] **Step 4: Create config/outreach.yml**

```yaml
# Outreach Pipeline Configuration
# Nexus-HeadHunter path (absolute)
nexus_path: "/home/13843K/Desktop/mygitprojects/Nexus-HeadHunter"

schedule:
  interval_days: 3
  max_leads_per_run: 15

search:
  # Auto-generated from profile.yml if empty. Add manual overrides here.
  queries: []
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

- [ ] **Step 5: Commit setup changes**

```bash
cd /home/13843K/Desktop/mygitprojects/career-ops
git add package.json package-lock.json .gitignore config/outreach.yml
git commit -m "chore: add outreach pipeline dependencies and config

Add better-sqlite3, outreach npm scripts, gitignore entries for
chrome profile and SQLite db, and outreach.yml config template."
```

---

### Task 3: Query Generator (outreach-query-gen.mjs)

Reads profile.yml archetypes and target roles, crosses them with title filters from outreach.yml, and generates LinkedIn search queries.

**Files:**
- Create: `/home/13843K/Desktop/mygitprojects/career-ops/outreach-query-gen.mjs`

- [ ] **Step 1: Create outreach-query-gen.mjs**

```javascript
#!/usr/bin/env node

/**
 * outreach-query-gen.mjs
 *
 * Generates LinkedIn People search queries from profile.yml archetypes
 * crossed with outreach.yml title filters.
 *
 * Usage:
 *   node outreach-query-gen.mjs              # Print generated queries
 *   node outreach-query-gen.mjs --json       # Output as JSON array
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadYaml(path) {
  return yaml.load(readFileSync(path, 'utf-8'));
}

function generateQueries(profile, outreach) {
  const titles = outreach.search?.title_filter || ['CTO', 'CEO', 'Founder'];
  const roleKeywords = new Set();

  for (const role of profile.target_roles?.primary || []) {
    const words = role.split(/\s+/).filter(w => w.length > 2 && !/engineer|developer|architect/i.test(w));
    words.forEach(w => roleKeywords.add(w));
  }
  for (const arch of profile.target_roles?.archetypes || []) {
    const words = arch.name.split(/[\s/]+/).filter(w => w.length > 2 && !/engineer|developer|architect/i.test(w));
    words.forEach(w => roleKeywords.add(w));
  }

  const locModifier = profile.compensation?.location_flexibility?.includes('Remote') ? 'remote' : (profile.location?.country || '');

  const queries = [];
  const keywordClusters = groupKeywords([...roleKeywords]);

  for (const title of titles) {
    for (const cluster of keywordClusters) {
      const q = `${title} ${cluster} startup ${locModifier}`.trim();
      queries.push(q);
    }
  }

  return [...new Set(queries)];
}

function groupKeywords(keywords) {
  if (keywords.length <= 2) return [keywords.join(' ')];
  const clusters = [];
  for (let i = 0; i < keywords.length; i += 2) {
    clusters.push(keywords.slice(i, i + 2).join(' '));
  }
  return clusters;
}

function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  const profilePath = join(__dirname, 'config/profile.yml');
  const outreachPath = join(__dirname, 'config/outreach.yml');

  const profile = loadYaml(profilePath);
  const outreach = loadYaml(outreachPath);

  const manualQueries = outreach.search?.queries?.filter(q => q) || [];
  if (manualQueries.length > 0) {
    if (jsonOutput) {
      console.log(JSON.stringify(manualQueries));
    } else {
      console.log('Using manual queries from outreach.yml:\n');
      manualQueries.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
    }
    return;
  }

  const queries = generateQueries(profile, outreach);

  if (jsonOutput) {
    console.log(JSON.stringify(queries));
  } else {
    console.log('Auto-generated queries from profile:\n');
    queries.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
    console.log(`\nTotal: ${queries.length} queries`);
    console.log('Tip: Add manual overrides in config/outreach.yml search.queries');
  }
}

main();
```

- [ ] **Step 2: Test query generator**

```bash
cd /home/13843K/Desktop/mygitprojects/career-ops
node outreach-query-gen.mjs
```

Expected: List of generated queries like:
```
Auto-generated queries from profile:

  1. CTO AI ML startup remote
  2. CTO Agentic Workflows startup remote
  ...

Total: N queries
```

```bash
node outreach-query-gen.mjs --json
```

Expected: JSON array of query strings.

- [ ] **Step 3: Commit query generator**

```bash
git add outreach-query-gen.mjs
git commit -m "feat: add outreach query generator

Generates LinkedIn search queries from profile.yml archetypes
crossed with outreach.yml title filters. Supports auto-generation
and manual overrides."
```

---

### Task 4: SQLite Database Layer (outreach-db.mjs)

Shared database module used by both outreach.mjs and send-outreach.mjs.

**Files:**
- Create: `/home/13843K/Desktop/mygitprojects/career-ops/outreach-db.mjs`

- [ ] **Step 1: Create outreach-db.mjs**

```javascript
#!/usr/bin/env node

/**
 * outreach-db.mjs
 *
 * SQLite database layer for the outreach pipeline.
 * Shared by outreach.mjs (write leads) and send-outreach.mjs (read approved, update sent).
 */

import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'data/outreach.db');

let _db = null;

export function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
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
    `);
  }
  return _db;
}

export function insertLead(lead, sourceQuery) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO leads (profile_url, name, headline, company, location, status, source_query, discovered_at)
    VALUES (?, ?, ?, ?, ?, 'found', ?, ?)
  `);
  const result = stmt.run(
    lead.profile_url,
    lead.name,
    lead.headline,
    lead.company || '',
    lead.location || '',
    sourceQuery,
    new Date().toISOString()
  );
  return result.changes > 0;
}

export function updateEnrichment(profileUrl, enrichment) {
  const db = getDb();
  db.prepare(`
    UPDATE leads SET
      about = ?,
      experience = ?,
      recent_posts = ?,
      email_guesses = ?,
      rag_hook = ?,
      status = 'enriched',
      enriched_at = ?
    WHERE profile_url = ?
  `).run(
    enrichment.about || '',
    JSON.stringify(enrichment.experience || []),
    JSON.stringify(enrichment.recent_posts || []),
    JSON.stringify(enrichment.email_guesses || []),
    enrichment.rag_hook || '',
    new Date().toISOString(),
    profileUrl
  );
}

export function updateDraft(profileUrl, draft) {
  const db = getDb();
  db.prepare(`
    UPDATE leads SET
      connection_note = ?,
      email_subject = ?,
      email_body = ?,
      status = 'drafted',
      drafted_at = ?
    WHERE profile_url = ?
  `).run(
    draft.connection_note || '',
    draft.email_subject || '',
    draft.email_body || '',
    new Date().toISOString(),
    profileUrl
  );
}

export function updateStatus(profileUrl, status, error = null) {
  const db = getDb();
  if (status === 'sent') {
    db.prepare('UPDATE leads SET status = ?, sent_at = ? WHERE profile_url = ?')
      .run(status, new Date().toISOString(), profileUrl);
  } else if (error) {
    db.prepare('UPDATE leads SET status = ?, error = ? WHERE profile_url = ?')
      .run(status, error, profileUrl);
  } else {
    db.prepare('UPDATE leads SET status = ? WHERE profile_url = ?')
      .run(status, profileUrl);
  }
}

export function getLeadsByStatus(status) {
  const db = getDb();
  return db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY discovered_at DESC').all(status);
}

export function getLeadByUrl(profileUrl) {
  const db = getDb();
  return db.prepare('SELECT * FROM leads WHERE profile_url = ?').get(profileUrl);
}

export function leadExists(profileUrl) {
  return !!getLeadByUrl(profileUrl);
}

export function getStats() {
  const db = getDb();
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM leads GROUP BY status').all();
  const stats = {};
  for (const row of rows) {
    stats[row.status] = row.count;
  }
  stats.total = db.prepare('SELECT COUNT(*) as count FROM leads').get().count;
  return stats;
}

export function getTodaySendCount() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'sent' AND sent_at LIKE ?").get(`${today}%`).count;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
```

- [ ] **Step 2: Test database module**

```bash
cd /home/13843K/Desktop/mygitprojects/career-ops
node -e "
import { getDb, insertLead, getStats, closeDb } from './outreach-db.mjs';
getDb();
const inserted = insertLead({ profile_url: 'https://test', name: 'Test', headline: 'CTO' }, 'test query');
console.log('Inserted:', inserted);
console.log('Stats:', getStats());
closeDb();
import { unlinkSync } from 'fs';
unlinkSync('data/outreach.db');
"
```

Expected:
```
Inserted: true
Stats: { found: 1, total: 1 }
```

- [ ] **Step 3: Commit database layer**

```bash
git add outreach-db.mjs
git commit -m "feat: add SQLite database layer for outreach pipeline

Provides lead storage, status tracking, dedup, and stats.
Used by outreach.mjs and send-outreach.mjs."
```

---

### Task 5: Main Orchestrator (outreach.mjs)

The core script. Reads profile, generates queries, calls Nexus bridge scripts via subprocess, stores results in SQLite, and outputs JSON for Claude Code review UX.

**Files:**
- Create: `/home/13843K/Desktop/mygitprojects/career-ops/outreach.mjs`

- [ ] **Step 1: Create outreach.mjs**

```javascript
#!/usr/bin/env node

/**
 * outreach.mjs -- Outreach Pipeline Orchestrator
 *
 * Usage:
 *   node outreach.mjs                  # Review pending drafts (JSON output)
 *   node outreach.mjs scan             # Run scout + enrich + draft pipeline
 *   node outreach.mjs status           # Show pipeline stats
 *   node outreach.mjs scan --dry-run   # Show queries without calling Nexus
 */

import { readFileSync, existsSync } from 'fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import {
  insertLead, updateEnrichment, updateDraft, updateStatus,
  getLeadsByStatus, leadExists, getStats, getTodaySendCount, closeDb
} from './outreach-db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// -- Config loading --

function loadConfig() {
  const outreachPath = join(__dirname, 'config/outreach.yml');
  if (!existsSync(outreachPath)) {
    console.error('config/outreach.yml not found. Run onboarding first.');
    process.exit(1);
  }
  return yaml.load(readFileSync(outreachPath, 'utf-8'));
}

function loadProfile() {
  return yaml.load(readFileSync(join(__dirname, 'config/profile.yml'), 'utf-8'));
}

function loadCv() {
  const cvPath = join(__dirname, 'cv.md');
  if (!existsSync(cvPath)) return '';
  return readFileSync(cvPath, 'utf-8');
}

function loadApplications() {
  const appsPath = join(__dirname, 'data/applications.md');
  if (!existsSync(appsPath)) return '';
  return readFileSync(appsPath, 'utf-8');
}

// -- Subprocess bridge --

function callBridge(nexusPath, scriptName, input) {
  const scriptPath = join(nexusPath, 'bridge', scriptName);
  if (!existsSync(scriptPath)) {
    throw new Error(`Bridge script not found: ${scriptPath}`);
  }

  const result = spawnSync('python3', [scriptPath], {
    cwd: nexusPath,
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 120000,
    env: { ...process.env },
  });

  if (result.error) {
    throw new Error(`Bridge ${scriptName} failed to start: ${result.error.message}`);
  }

  if (!result.stdout) {
    throw new Error(`Bridge ${scriptName} exited ${result.status}: ${result.stderr || 'no output'}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(`Bridge ${scriptName} returned invalid JSON: ${result.stdout.slice(0, 200)}`);
  }

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  return parsed;
}

// -- Pipeline stages --

function getQueries(config) {
  const manualQueries = config.search?.queries?.filter(q => q) || [];
  if (manualQueries.length > 0) return manualQueries;

  // Auto-generate via query-gen script
  const result = spawnSync('node', [join(__dirname, 'outreach-query-gen.mjs'), '--json'], {
    cwd: __dirname,
    encoding: 'utf-8',
    timeout: 10000,
  });

  if (result.status !== 0 || !result.stdout) {
    console.error('Failed to generate queries:', result.stderr);
    return [];
  }

  return JSON.parse(result.stdout);
}

function runScout(config, queries) {
  const nexusPath = config.nexus_path;
  const chromeData = join(nexusPath, 'chrome_data');
  let totalNew = 0;

  for (const query of queries) {
    console.log(`\n  Scouting: "${query}"`);
    try {
      const result = callBridge(nexusPath, 'scout_bridge.py', {
        query,
        max_pages: 2,
        chrome_data: chromeData,
      });

      const leads = result.leads || [];
      let newCount = 0;
      for (const lead of leads) {
        if (!leadExists(lead.profile_url)) {
          if (insertLead(lead, query)) newCount++;
        }
      }
      console.log(`  Found ${leads.length} leads, ${newCount} new`);
      totalNew += newCount;
    } catch (err) {
      console.error(`  Scout error: ${err.message}`);
    }
  }

  return totalNew;
}

function runEnrichment(config) {
  const nexusPath = config.nexus_path;
  const chromeData = join(nexusPath, 'chrome_data');
  const resumeText = loadCv();

  const leads = getLeadsByStatus('found');
  if (leads.length === 0) {
    console.log('  No leads to enrich.');
    return 0;
  }

  console.log(`\n  Enriching ${leads.length} leads...`);
  let enriched = 0;

  for (const lead of leads) {
    console.log(`  > ${lead.name} (${lead.company || 'unknown'})`);
    try {
      const result = callBridge(nexusPath, 'investigator_bridge.py', {
        lead: { name: lead.name, profile_url: lead.profile_url, headline: lead.headline, company: lead.company },
        resume_text: resumeText,
        chrome_data: chromeData,
      });
      updateEnrichment(lead.profile_url, result);
      enriched++;
      console.log(`    Enriched`);
    } catch (err) {
      updateStatus(lead.profile_url, 'unreachable', err.message);
      console.error(`    ${err.message}`);
    }
  }

  return enriched;
}

function runDrafting(config) {
  const nexusPath = config.nexus_path;
  const profile = loadProfile();

  const candidate = {
    name: profile.candidate?.full_name || '',
    headline: profile.narrative?.headline || '',
    proof_points: (profile.narrative?.proof_points || []).map(pp => `${pp.name}: ${pp.hero_metric}`),
    target_role: (profile.target_roles?.primary || ['AI Engineer'])[0],
  };

  const leads = getLeadsByStatus('enriched');
  if (leads.length === 0) {
    console.log('  No enriched leads to draft messages for.');
    return 0;
  }

  console.log(`\n  Drafting messages for ${leads.length} leads...`);
  let drafted = 0;

  for (const lead of leads) {
    console.log(`  > ${lead.name}`);
    try {
      const enrichment = {
        about: lead.about || '',
        recent_posts: JSON.parse(lead.recent_posts || '[]'),
        email_guesses: JSON.parse(lead.email_guesses || '[]'),
        rag_hook: lead.rag_hook || '',
      };

      const result = callBridge(nexusPath, 'copywriter_bridge.py', {
        lead: { name: lead.name, headline: lead.headline, company: lead.company, profile_url: lead.profile_url, location: lead.location },
        enrichment,
        candidate,
      });

      updateDraft(lead.profile_url, result);
      drafted++;
      console.log(`    Draft ready (${result.connection_note.length} chars)`);
    } catch (err) {
      updateStatus(lead.profile_url, 'draft_failed', err.message);
      console.error(`    ${err.message}`);
    }
  }

  return drafted;
}

// -- Dedup against applications.md --

function checkAppliedCompanies(leads) {
  const appsText = loadApplications();
  const appliedCompanies = new Map();

  for (const match of appsText.matchAll(/\|\s*(\d+)\s*\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
    const num = match[1].trim();
    const company = match[2].trim().toLowerCase();
    const role = match[3].trim();
    const score = match[4].trim();
    appliedCompanies.set(company, { num, role, score });
  }

  return leads.map(lead => {
    const company = (lead.company || '').toLowerCase();
    const applied = appliedCompanies.get(company);
    return {
      ...lead,
      applied_match: applied ? `Already applied to ${lead.company} (Report #${applied.num}, Score ${applied.score})` : null,
    };
  });
}

// -- Status display --

function showStatus() {
  const stats = getStats();
  const todaySent = getTodaySendCount();

  console.log(JSON.stringify({
    total: stats.total || 0,
    found: stats.found || 0,
    enriched: stats.enriched || 0,
    drafted: stats.drafted || 0,
    approved: stats.approved || 0,
    sent: stats.sent || 0,
    skipped: stats.skipped || 0,
    send_failed: stats.send_failed || 0,
    unreachable: stats.unreachable || 0,
    draft_failed: stats.draft_failed || 0,
    sent_today: todaySent,
  }, null, 2));
}

// -- Main --

function main() {
  const args = process.argv.slice(2);
  const command = args.find(a => !a.startsWith('-')) || 'review';
  const dryRun = args.includes('--dry-run');

  const config = loadConfig();

  if (command === 'status') {
    showStatus();
    closeDb();
    return;
  }

  if (command === 'scan') {
    console.log(`${'='.repeat(45)}`);
    console.log('Outreach Pipeline -- Scan');
    console.log(`${'='.repeat(45)}`);

    const queries = getQueries(config);
    const maxLeads = config.schedule?.max_leads_per_run || 15;
    console.log(`Queries: ${queries.length}, Max leads: ${maxLeads}`);

    if (dryRun) {
      console.log('\n--dry-run: would run these queries:');
      queries.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
      closeDb();
      return;
    }

    // Scout > Enrich > Draft
    const newLeads = runScout(config, queries);
    console.log(`\nScout complete: ${newLeads} new leads`);

    if (newLeads > 0) {
      const enriched = runEnrichment(config);
      console.log(`Enrichment complete: ${enriched} enriched`);

      if (enriched > 0) {
        const drafted = runDrafting(config);
        console.log(`Drafting complete: ${drafted} messages drafted`);
      }
    }

    showStatus();
    closeDb();
    return;
  }

  if (command === 'review') {
    const drafted = getLeadsByStatus('drafted');
    if (drafted.length === 0) {
      console.log(JSON.stringify({ queue: [], total: 0 }));
      closeDb();
      return;
    }

    const withApplied = checkAppliedCompanies(drafted);

    console.log(JSON.stringify({
      queue: withApplied.map(lead => ({
        id: lead.id,
        name: lead.name,
        headline: lead.headline,
        company: lead.company,
        location: lead.location,
        about: lead.about,
        recent_posts: JSON.parse(lead.recent_posts || '[]'),
        rag_hook: lead.rag_hook,
        connection_note: lead.connection_note,
        email_subject: lead.email_subject,
        email_body: lead.email_body,
        profile_url: lead.profile_url,
        applied_match: lead.applied_match,
        discovered_at: lead.discovered_at,
      })),
      total: withApplied.length,
    }, null, 2));

    closeDb();
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Usage: node outreach.mjs [scan|review|status] [--dry-run]');
  process.exit(1);
}

main();
```

- [ ] **Step 2: Test orchestrator with --dry-run**

```bash
cd /home/13843K/Desktop/mygitprojects/career-ops
node outreach.mjs scan --dry-run
```

Expected: Lists generated queries without calling Nexus.

```bash
node outreach.mjs status
```

Expected: Shows all-zero stats (empty database).

- [ ] **Step 3: Commit orchestrator**

```bash
git add outreach.mjs
git commit -m "feat: add outreach pipeline orchestrator

Calls Nexus bridge scripts via subprocess (Scout > Investigator >
Copywriter), stores leads in SQLite, dedup against applications.md,
outputs JSON for Claude Code review UX."
```

---

### Task 6: LinkedIn Sender (send-outreach.mjs)

Reads approved leads from the database and sends LinkedIn connection requests with notes via Playwright.

**Files:**
- Create: `/home/13843K/Desktop/mygitprojects/career-ops/send-outreach.mjs`

- [ ] **Step 1: Create send-outreach.mjs**

```javascript
#!/usr/bin/env node

/**
 * send-outreach.mjs -- LinkedIn Connection Sender
 *
 * Usage:
 *   node send-outreach.mjs              # Send all approved leads
 *   node send-outreach.mjs --login      # Open browser for LinkedIn login
 *   node send-outreach.mjs --dry-run    # Show what would be sent
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import yaml from 'js-yaml';
import {
  getLeadsByStatus, updateStatus, getTodaySendCount, closeDb
} from './outreach-db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  return yaml.load(readFileSync(join(__dirname, 'config/outreach.yml'), 'utf-8'));
}

function randomDelay(range) {
  const [min, max] = range;
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function isLoggedIn(page) {
  const url = page.url();
  return !url.includes('signup') && !url.includes('authwall') && !url.includes('login');
}

async function sendConnectionRequest(page, profileUrl, note) {
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000 + Math.random() * 3000);

  // Try to find Connect button
  let connectBtn = await page.$('button:has-text("Connect")');

  if (!connectBtn) {
    // Check "More" dropdown
    const moreBtn = await page.$('button:has-text("More")');
    if (moreBtn) {
      await moreBtn.click();
      await sleep(1000);
      const connectInMore = await page.$('[role="menuitem"]:has-text("Connect")');
      if (connectInMore) {
        await connectInMore.click();
      } else {
        return { success: false, reason: 'Connect button not found in More menu' };
      }
    } else {
      return { success: false, reason: 'Connect button not found' };
    }
  } else {
    await connectBtn.click();
  }

  await sleep(1500);

  // Click "Add a note"
  const addNoteBtn = await page.$('button:has-text("Add a note")');
  if (addNoteBtn) {
    await addNoteBtn.click();
    await sleep(1000);
  }

  // Fill in the note
  const textarea = await page.$('textarea[name="message"]') || await page.$('#custom-message');
  if (!textarea) {
    return { success: false, reason: 'Message textarea not found' };
  }
  await textarea.fill(note);
  await sleep(1000);

  // Click Send
  const sendBtn = await page.$('button:has-text("Send")');
  if (!sendBtn) {
    return { success: false, reason: 'Send button not found' };
  }

  await sendBtn.click();
  await sleep(2000);

  // Check for rate limit modal
  const errorModal = await page.$('.artdeco-modal:has-text("limit")');
  if (errorModal) {
    return { success: false, reason: 'LinkedIn rate limit reached' };
  }

  return { success: true };
}

async function loginFlow(config) {
  const chromeDataDir = resolve(__dirname, config.linkedin?.chrome_data || './outreach-chrome');
  if (!existsSync(chromeDataDir)) mkdirSync(chromeDataDir, { recursive: true });

  console.log('Opening browser for LinkedIn login...');
  console.log('Log in manually. The session will be saved.\n');

  const context = await chromium.launchPersistentContext(chromeDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });

  console.log('Waiting for login... (close the browser window when done)');

  await new Promise(resolve => {
    context.on('close', resolve);
  });

  console.log('Session saved. You can now run: node send-outreach.mjs');
}

async function sendApproved(config, dryRun) {
  const maxPerDay = config.linkedin?.max_sends_per_day || 10;
  const delayRange = config.linkedin?.delay_between_sends || [30, 90];
  const chromeDataDir = resolve(__dirname, config.linkedin?.chrome_data || './outreach-chrome');

  if (!existsSync(chromeDataDir)) {
    console.error('No Chrome profile found. Run: node send-outreach.mjs --login');
    process.exit(1);
  }

  const todaySent = getTodaySendCount();
  const remaining = maxPerDay - todaySent;

  if (remaining <= 0) {
    console.log(`Daily send limit reached (${maxPerDay}). Try again tomorrow.`);
    return;
  }

  const approved = getLeadsByStatus('approved');
  if (approved.length === 0) {
    console.log('No approved leads to send. Run /career-ops outreach to review drafts first.');
    return;
  }

  const toSend = approved.slice(0, remaining);
  console.log(`${'='.repeat(45)}`);
  console.log(`Sending ${toSend.length} connection requests`);
  console.log(`(${todaySent} sent today, limit: ${maxPerDay})`);
  console.log(`${'='.repeat(45)}`);

  if (dryRun) {
    for (const lead of toSend) {
      console.log(`  Would send to: ${lead.name} (${lead.company}) -- ${lead.connection_note.length} chars`);
    }
    return;
  }

  const context = await chromium.launchPersistentContext(chromeDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = context.pages()[0] || await context.newPage();

    // Verify login
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    if (!await isLoggedIn(page)) {
      console.error('LinkedIn session expired. Run: node send-outreach.mjs --login');
      return;
    }

    console.log('LinkedIn session active\n');

    let sentCount = 0;
    for (let i = 0; i < toSend.length; i++) {
      const lead = toSend[i];
      console.log(`[${i + 1}/${toSend.length}] ${lead.name} -- ${lead.company || 'Unknown'}`);

      const result = await sendConnectionRequest(page, lead.profile_url, lead.connection_note);

      if (result.success) {
        updateStatus(lead.profile_url, 'sent');
        sentCount++;
        console.log(`  Sent`);
      } else {
        if (result.reason.includes('rate limit')) {
          console.log(`  Rate limited -- halting sends. Remaining stay approved.`);
          break;
        }
        updateStatus(lead.profile_url, 'send_failed', result.reason);
        console.log(`  Failed: ${result.reason}`);
      }

      // Delay between sends
      if (i < toSend.length - 1) {
        const delay = randomDelay(delayRange);
        console.log(`  Waiting ${Math.round(delay / 1000)}s...`);
        await sleep(delay);
      }
    }

    console.log(`\n${'='.repeat(45)}`);
    console.log(`Done: ${sentCount} sent, ${toSend.length - sentCount} failed/skipped`);
    console.log(`${'='.repeat(45)}`);

  } finally {
    await context.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const config = loadConfig();

  if (args.includes('--login')) {
    await loginFlow(config);
    return;
  }

  const dryRun = args.includes('--dry-run');
  await sendApproved(config, dryRun);
  closeDb();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  closeDb();
  process.exit(1);
});
```

- [ ] **Step 2: Test sender with --dry-run**

```bash
cd /home/13843K/Desktop/mygitprojects/career-ops
node send-outreach.mjs --dry-run
```

Expected: `No approved leads to send.` (empty database)

- [ ] **Step 3: Commit sender**

```bash
git add send-outreach.mjs
git commit -m "feat: add LinkedIn connection sender with Playwright

Sends approved connection requests with personalized notes.
Own persistent Chrome profile, rate limiting (10/day default),
human-like delays, session management."
```

---

### Task 7: Mode File + CLAUDE.md Integration

Create the outreach mode file and update CLAUDE.md routing.

**Files:**
- Create: `/home/13843K/Desktop/mygitprojects/career-ops/modes/outreach.md`
- Modify: `/home/13843K/Desktop/mygitprojects/career-ops/CLAUDE.md`

- [ ] **Step 1: Create modes/outreach.md**

```markdown
# Mode: outreach -- Startup Leader Outreach Pipeline

Find CEOs/CTOs of startups that align with your profile, draft personalized LinkedIn connection notes, and send them after your review.

## Sub-commands

| Command | Action |
|---------|--------|
| `/career-ops outreach` | Review pending drafts -- approve, edit, skip |
| `/career-ops outreach scan` | Run a new scout pipeline (outside schedule) |
| `/career-ops outreach login` | Open browser for LinkedIn login |
| `/career-ops outreach status` | Show pipeline stats |
| `/career-ops outreach config` | Show/edit outreach.yml |

## Prerequisites

1. `config/outreach.yml` exists with valid `nexus_path`
2. Nexus-HeadHunter installed at the configured path with `bridge/` scripts
3. LinkedIn session active (`node send-outreach.mjs --login` for first-time setup)
4. `GROQ_API_KEY` environment variable set

## Workflow

### Scan (discovery)

When user runs `/career-ops outreach scan`:

1. Run `node outreach.mjs scan` to execute the pipeline
2. Report results: X new leads found, Y enriched, Z drafted
3. If new drafts exist, offer to start review immediately

### Review (default)

When user runs `/career-ops outreach`:

1. Run `node outreach.mjs review` to get pending drafts as JSON
2. Present each lead one at a time in this format:

--- Lead 1/N -----------------------------------------------

  {Name} -- {Title} @ {Company}
  Location: {location}
  Headline: "{headline}"
  Recent post: "{first recent post}"
  RAG match: {rag_hook}
  {applied_match warning if exists}

  Connection Note ({char_count} chars):
  +----------------------------------------------------------+
  | {connection_note text}                                     |
  +----------------------------------------------------------+

  [a] Approve   [e] Edit message   [s] Skip   [q] Quit review

3. Process user choice:
   - **a (approve)**: Update lead status to `approved` in outreach.db
   - **e (edit)**: Claude presents message, user dictates changes, Claude updates and re-presents for approval
   - **s (skip)**: Update status to `skipped`
   - **q (quit)**: Stop review, remaining stay as `drafted`

4. After review:

   Review complete: X approved, Y edited, Z skipped
   Send X approved messages now? [y/n]

5. If yes, run `node send-outreach.mjs` and monitor output

### Login

Run `node send-outreach.mjs --login` -- opens Playwright in headed mode for manual LinkedIn login.

### Status

Run `node outreach.mjs status` and present the stats.

### Config

Read `config/outreach.yml` and present it. Offer to edit search queries, title filters, schedule interval, or excluded companies.

## Review Rules

- NEVER send a message without explicit user approval
- Show character count on connection notes (LinkedIn limit: 300)
- Warn if note exceeds 300 characters
- Flag leads at companies the user already applied to
- Flag leads already contacted via Nexus standalone

## Safety

- Max 10 connection requests per day (configurable)
- Random 30-90 second delay between sends
- If rate limited, halt immediately
- Session check before any send batch
```

- [ ] **Step 2: Update CLAUDE.md -- Add outreach to Skill Modes table**

Add this row to the `### Skill Modes` table:
```
| Asks to find and message startup leaders | `outreach` |
```

- [ ] **Step 3: Update CLAUDE.md -- Add to command list and Main Files table**

Add to discovery mode commands:
```
  /career-ops outreach → Find startup leaders, draft LinkedIn messages, send connections
```

Add to Main Files table:
```
| `outreach.mjs` | Outreach pipeline orchestrator |
| `send-outreach.mjs` | LinkedIn connection sender (Playwright) |
| `outreach-query-gen.mjs` | Search query generator from profile |
| `outreach-db.mjs` | SQLite database layer for outreach |
```

Add to npm Scripts table:
```
| `npm run outreach` | Run outreach pipeline orchestrator |
| `npm run outreach:send` | Send approved LinkedIn connections |
| `npm run outreach:login` | Open browser for LinkedIn login |
| `npm run outreach:query` | Generate search queries from profile |
```

- [ ] **Step 4: Commit mode and CLAUDE.md updates**

```bash
cd /home/13843K/Desktop/mygitprojects/career-ops
git add modes/outreach.md CLAUDE.md
git commit -m "feat: add outreach mode and CLAUDE.md integration

New /career-ops outreach command with sub-commands for scan, review,
login, status, and config. Updates routing table and discovery menu."
```

---

### Task 8: Integration Test

Verify the full pipeline works end-to-end.

- [ ] **Step 1: Verify all new scripts parse without syntax errors**

```bash
cd /home/13843K/Desktop/mygitprojects/career-ops
node --check outreach.mjs && echo "OK outreach.mjs"
node --check send-outreach.mjs && echo "OK send-outreach.mjs"
node --check outreach-query-gen.mjs && echo "OK outreach-query-gen.mjs"
node --check outreach-db.mjs && echo "OK outreach-db.mjs"
```

Expected: All OK.

- [ ] **Step 2: Verify Python bridge scripts parse without syntax errors**

```bash
cd /home/13843K/Desktop/mygitprojects/Nexus-HeadHunter
python3 -m py_compile bridge/scout_bridge.py && echo "OK scout_bridge.py"
python3 -m py_compile bridge/investigator_bridge.py && echo "OK investigator_bridge.py"
python3 -m py_compile bridge/copywriter_bridge.py && echo "OK copywriter_bridge.py"
```

Expected: All OK.

- [ ] **Step 3: Test query generation end-to-end**

```bash
cd /home/13843K/Desktop/mygitprojects/career-ops
node outreach-query-gen.mjs
node outreach-query-gen.mjs --json
```

Expected: Meaningful queries generated from profile.

- [ ] **Step 4: Test orchestrator dry-run**

```bash
node outreach.mjs scan --dry-run
node outreach.mjs status
node outreach.mjs review
```

Expected: Dry-run shows queries, status shows zeros, review shows empty queue.

- [ ] **Step 5: Test sender dry-run**

```bash
node send-outreach.mjs --dry-run
```

Expected: `No approved leads to send.`

- [ ] **Step 6: Run existing career-ops test suite**

```bash
node test-all.mjs --quick
```

Expected: All existing tests pass.

- [ ] **Step 7: Commit any test fixes if needed**

```bash
git add -A && git status
```

If changes needed, commit with appropriate message.

---

### Task 9: Recurring Schedule Setup

Document and configure the recurring scan.

- [ ] **Step 1: Verify schedule is documentable**

The recurring scan is triggered via Claude Code's `/schedule` or `/loop` skill:
```
/career-ops outreach scan
```

Configured to run every `interval_days` from `outreach.yml` (default: 3 days).

Each run:
1. Runs `node outreach.mjs scan`
2. If new drafts generated, notifies user to review

- [ ] **Step 2: Final verification -- list all commits**

```bash
cd /home/13843K/Desktop/mygitprojects/career-ops
git log --oneline -10
```

Verify commit history shows all tasks.
