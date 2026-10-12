#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillNames = ["using-bridge", "bridge-web-audit"];
const write = process.argv.slice(2).includes("--write");
if (process.argv.slice(2).some((arg) => !["--check", "--write"].includes(arg))) {
  throw new Error("Usage: node scripts/sync-bridge-skill.mjs [--check|--write]");
}

function files(folder, prefix = "") {
  return readdirSync(join(folder, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) return files(folder, path);
    if (entry.isFile()) return [path];
    throw new Error(`Skill entry must be a regular file or directory: ${path}`);
  }).sort();
}

let mismatches = 0;
let totalFiles = 0;
for (const skillName of skillNames) {
const source = join(root, "skills", skillName);
const mirrors = [".codex", ".claude", ".agents"].map(client => join(root, client, "skills", skillName));
const canonical = files(source);
totalFiles += canonical.length;
for (const mirror of mirrors) {
  if (write) mkdirSync(mirror, { recursive: true });
  for (const relative of canonical) {
    const expected = readFileSync(join(source, relative));
    const target = join(mirror, relative);
    if (write) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, expected);
    }
    let actual;
    try { actual = readFileSync(target); } catch { actual = null; }
    if (actual === null || !expected.equals(actual)) {
      process.stderr.write(`Skill mirror differs: ${target.slice(root.length + 1)}\n`);
      mismatches++;
    }
  }
  for (const relative of existsSync(mirror) ? files(mirror) : []) {
    if (!canonical.includes(relative)) {
      process.stderr.write(`Unexpected mirror file preserved: ${join(mirror, relative).slice(root.length + 1)}\n`);
      mismatches++;
    }
  }
}
}
process.stdout.write(`${totalFiles} canonical files in ${skillNames.length} skills, 3 client mirrors each, ${mismatches} differences\n`);
process.exitCode = mismatches === 0 ? 0 : 1;
