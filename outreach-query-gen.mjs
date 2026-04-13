#!/usr/bin/env node
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
