#!/usr/bin/env node
// Documentation gate for the public docs set.
//
// Checks, without any dependency:
//   1. every relative Markdown link and image target resolves to a file that exists;
//   2. every in-repo `#anchor` matches a real heading in the target file;
//   3. no documentation file embeds an absolute filesystem path.
//
// Usage: node docs/tools/check-doc-links.mjs
// Exit code 0 means the documentation set is internally consistent.

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ROOT_FILES = ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];
const DOC_DIRS = ['docs'];

const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const ABSOLUTE_PATH_RE = /(?:[A-Za-z]:\\Users\\|\/home\/[a-z]|\/Users\/[A-Za-z])/;

/** @returns {Promise<string[]>} repo-relative Markdown files to check */
async function collect() {
  const files = ROOT_FILES.filter((f) => existsSync(path.join(repoRoot, f)));
  for (const dir of DOC_DIRS) {
    await walk(path.join(repoRoot, dir), files);
  }
  return files;
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(path.relative(repoRoot, full).split(path.sep).join('/'));
  }
}

/** GitHub-compatible heading slug, good enough for the anchors this repo uses. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

async function headingSlugs(absFile) {
  const text = await readFile(absFile, 'utf8');
  const slugs = new Set();
  const counts = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (!match) continue;
    const base = slug(match[1]);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return slugs;
}

const problems = [];
const files = await collect();

for (const rel of files) {
  const abs = path.join(repoRoot, rel);
  const text = await readFile(abs, 'utf8');

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (ABSOLUTE_PATH_RE.test(line)) {
      problems.push(`${rel}:${index + 1} absolute filesystem path in documentation`);
    }
  });

  for (const match of text.matchAll(LINK_RE)) {
    const target = match[1];
    if (/^(https?:|mailto:|tel:)/i.test(target)) continue;
    if (target.startsWith('#')) {
      const anchors = await headingSlugs(abs);
      if (!anchors.has(target.slice(1))) problems.push(`${rel} -> ${target} (missing local anchor)`);
      continue;
    }
    const [rawPath, anchor] = target.split('#');
    const resolved = path.resolve(path.dirname(abs), decodeURIComponent(rawPath));
    let info;
    try {
      info = await stat(resolved);
    } catch {
      problems.push(`${rel} -> ${target} (missing target)`);
      continue;
    }
    if (anchor && info.isFile() && resolved.endsWith('.md')) {
      const anchors = await headingSlugs(resolved);
      if (!anchors.has(anchor)) problems.push(`${rel} -> ${target} (missing anchor)`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Documentation check failed with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`Documentation check passed: ${files.length} files, no broken internal links or absolute paths.`);
