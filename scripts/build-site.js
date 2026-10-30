#!/usr/bin/env node
/* ==========================================================================
   Documentation portal + golden-build dashboard for GitHub Pages
   (.github/workflows/pages.yml; https://fennereduardo.github.io/gherkin-ai-cli/)

   - README.md, CHANGELOG.md and docs/*.md rendered to site/*.html (links to
     .md files rewritten to .html);
   - site/goldens.html and site/goldens.json: every golden build of
     scripts/golden-stacks.js with its maintenance tier, and, when
     GOLDEN_RUN_ID / GITHUB_TOKEN / GITHUB_REPOSITORY are set, the result of
     its job in that CI run (the evidence behind "built and tested in CI").

   Usage: npm run build && node scripts/build-site.js [outDir=site]
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.resolve(root, process.argv[2] || 'site');

async function goldenResults() {
  const { GOLDEN_RUN_ID: runId, GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = process.env;
  if (!runId || !token || !repo) return { run: null, jobs: new Map() };
  const jobs = new Map();
  for (let page = 1; page < 10; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} reading the jobs of run ${runId}`);
    const body = await res.json();
    for (const job of body.jobs) {
      const m = job.name.match(/^golden \((.+)\)$/);
      if (m) jobs.set(m[1], { conclusion: job.conclusion, seconds: job.completed_at && job.started_at ? Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000) : null, url: job.html_url });
    }
    if (body.jobs.length < 100) break;
  }
  return { run: { id: runId, url: `https://github.com/${repo}/actions/runs/${runId}` }, jobs };
}

const escape = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function layout(title, body, version) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · gherkin-ai</title>
<meta name="description" content="gherkin-ai: spec-driven development governance for AI coding agents.">
<style>
:root { color-scheme: light dark; --fg: #1f2328; --bg: #ffffff; --muted: #59636e; --line: #d1d9e0; --accent: #0969da; --ok: #1a7f37; --bad: #cf222e; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --bg: #0d1117; --muted: #9198a1; --line: #3d444d; --accent: #4493f8; --ok: #3fb950; --bad: #f85149; } }
body { margin: 0; font: 16px/1.6 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
header, main { max-width: 960px; margin: 0 auto; padding: 0 16px; }
header { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; border-bottom: 1px solid var(--line); padding-block: 12px; }
header a { color: var(--fg); text-decoration: none; } header nav a { color: var(--accent); margin-right: 12px; }
a { color: var(--accent); } code, pre { font-family: ui-monospace, monospace; font-size: 0.9em; }
pre { overflow-x: auto; padding: 12px; border: 1px solid var(--line); border-radius: 6px; }
table { border-collapse: collapse; display: block; overflow-x: auto; } th, td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; vertical-align: top; }
.ok { color: var(--ok); } .bad { color: var(--bad); } .muted { color: var(--muted); }
</style>
</head>
<body>
<header><a href="index.html"><strong>gherkin-ai</strong></a> <span class="muted">${escape(version)}</span>
<nav><a href="index.html">Overview</a><a href="COMMANDS.html">Commands</a><a href="ADOPTION.html">Adoption</a><a href="ENTERPRISE.html">Enterprise</a><a href="goldens.html">Goldens</a><a href="CHANGELOG.html">Changelog</a></nav></header>
<main>
${body}
</main>
</body>
</html>
`;
}

async function main() {
  const { Marked } = await import('marked');
  const version = `v${require(path.join(root, 'package.json')).version}`;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // Heading ids as GitHub computes them, so "doc.html#section" links from the Markdown keep working.
  let used = new Map();
  const slug = text => {
    const base = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  const marked = new Marked({
    renderer: {
      heading({ tokens, depth, text }) {
        return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      }
    }
  });

  const rootDocs = ['CHANGELOG', 'SECURITY', 'SUPPORT', 'CONTRIBUTING', 'CODE_OF_CONDUCT', 'GOVERNANCE', 'MAINTAINERS'].filter(n => fs.existsSync(path.join(root, `${n}.md`)));
  const pages = [['index', path.join(root, 'README.md')], ...rootDocs.map(n => [n, path.join(root, `${n}.md`)]),
    ...fs.readdirSync(path.join(root, 'docs')).filter(f => f.endsWith('.md')).map(f => [path.basename(f, '.md'), path.join(root, 'docs', f)])];
  for (const [name, file] of pages) {
    const md = fs.readFileSync(file, 'utf8')
      // Links between documents: README -> docs/X.md, docs -> X.md or ../README.md.
      .replace(/\]\((?:\.\.\/)?(?:docs\/)?([A-Za-z0-9_.-]+)\.md(#[^)]*)?\)/g, (_m, target, hash = '') => `](${target === 'README' ? 'index' : target}.html${hash})`);
    const title = (md.match(/^#\s+(.+)$/m) || [null, name])[1];
    used = new Map();
    fs.writeFileSync(path.join(out, `${name}.html`), layout(title, marked.parse(md), version));
  }

  const { STACKS } = require('./golden-stacks');
  const { STACK_SUPPORT } = require(path.join(root, 'dist', 'generators', 'stack-support'));
  const { run, jobs } = await goldenResults();
  const rows = Object.keys(STACKS).map(name => {
    const support = STACK_SUPPORT.find(s => s.golden === name);
    return { golden: name, stack: support ? support.label : name, maintenance: support ? support.maintenance : null, result: jobs.get(name) || null };
  });
  fs.writeFileSync(path.join(out, 'goldens.json'), JSON.stringify({ version, run, goldens: rows }, null, 2) + '\n');
  const passed = rows.filter(r => r.result && r.result.conclusion === 'success').length;
  const table = rows.map(r => `<tr><td><code>${escape(r.golden)}</code></td><td>${escape(r.stack)}</td><td>${escape(r.maintenance || '')}</td><td>${r.result
    ? `<a class="${r.result.conclusion === 'success' ? 'ok' : 'bad'}" href="${escape(r.result.url)}">${escape(r.result.conclusion)}</a>${r.result.seconds != null ? ` <span class="muted">${r.result.seconds}s</span>` : ''}` : '<span class="muted">not run</span>'}</td></tr>`).join('\n');
  const body = `<h1>Golden builds</h1>
<p>Every stack gherkin-ai calls stable is generated, built and tested in its official image on every CI run (<code>scripts/golden-build.js</code>): backends also run the runtime integration suite IT1–IT7 against real PostgreSQL and their broker, and their production image must start and answer its probes. ${run ? `This page shows CI run <a href="${escape(run.url)}">${escape(run.id)}</a> of ${escape(version)}: <strong>${passed}/${rows.length}</strong> passed.` : 'No CI run attached to this build of the page.'} Machine-readable: <a href="goldens.json">goldens.json</a>.</p>
<table><thead><tr><th>Golden</th><th>Stack</th><th>Tier</th><th>Result</th></tr></thead><tbody>
${table}
</tbody></table>`;
  fs.writeFileSync(path.join(out, 'goldens.html'), layout('Golden builds', body, version));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  console.log(`site: ${pages.length + 1} pages in ${path.relative(root, out)}${run ? `, ${passed}/${rows.length} goldens passed in run ${run.id}` : ''}`);
}

main().catch(err => { console.error(err); process.exit(1); });
