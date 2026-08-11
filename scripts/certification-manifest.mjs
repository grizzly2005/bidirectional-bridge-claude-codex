#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const MANIFEST_PATH = "certification/manifest-v1.json";
const DOMAIN_SEPARATOR = Buffer.from("bridge-certification-manifest-v1\0", "utf8");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(repoRoot, MANIFEST_PATH), "utf8"));

function fail(message) {
  process.stderr.write(`certification manifest error: ${message}\n`);
  process.exit(1);
}

function bytewisePathOrder(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizedRelativePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").includes("..")
  ) {
    fail(`invalid project-relative path: ${JSON.stringify(path)}`);
  }
  const absolute = resolve(repoRoot, ...path.split("/"));
  const rel = relative(repoRoot, absolute);
  if (rel.length === 0 || rel.startsWith(`..${sep}`) || rel === "..") {
    fail(`path escapes repository root: ${path}`);
  }
  return { absolute, relative: path };
}

if (manifest.version !== 1 || manifest.hash_definition?.algorithm !== "sha256") {
  fail("unsupported manifest version or hash algorithm");
}
if (!Array.isArray(manifest.files) || !Array.isArray(manifest.exclusion_rules)) {
  fail("manifest files and exclusion_rules must be arrays");
}

const files = [...manifest.files];
const sortedFiles = [...files].sort(bytewisePathOrder);
if (new Set(files).size !== files.length) fail("manifest contains duplicate paths");
if (files.some((path, index) => path !== sortedFiles[index])) {
  fail("manifest files are not in ascending bytewise UTF-8 order");
}
if (!files.includes(MANIFEST_PATH) || !files.includes("scripts/certification-manifest.mjs")) {
  fail("manifest must include its definition and implementation");
}

const exclusionRules = manifest.exclusion_rules.map((rule) => ({
  ...rule,
  regex: new RegExp(rule.pattern, "i"),
}));
const explicitDatabaseFixtures = new Set(manifest.explicit_runtime_database_fixtures ?? []);
const excludedBy = (path) =>
  exclusionRules.find((rule) => rule.regex.test(path)) ??
  (path.toLowerCase().endsWith(".db") && !explicitDatabaseFixtures.has(path)
    ? { pattern: "*.db", reason: "runtime database not declared as a fixture" }
    : null);

for (const path of files) {
  normalizedRelativePath(path);
  const exclusion = excludedBy(path);
  if (exclusion) fail(`listed path matches exclusion ${exclusion.pattern}: ${path}`);
}

const gitCandidates = execFileSync(
  "git",
  ["-C", repoRoot, "ls-files", "-co", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const listed = new Set(files);
const excludedGitCandidates = [];
const unexpectedGitCandidates = [];
for (const path of new Set(gitCandidates)) {
  if (listed.has(path)) continue;
  const exclusion = excludedBy(path);
  if (exclusion) {
    excludedGitCandidates.push({ path, reason: exclusion.reason });
  } else {
    unexpectedGitCandidates.push(path);
  }
}
if (unexpectedGitCandidates.length > 0) {
  fail(`unlisted project material: ${unexpectedGitCandidates.sort(bytewisePathOrder).join(", ")}`);
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const hash = createHash("sha256");
hash.update(DOMAIN_SEPARATOR);
for (const path of files) {
  const { absolute } = normalizedRelativePath(path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`listed path is not a regular file: ${path}`);
  const content = readFileSync(absolute);
  if (content.includes(0)) fail(`listed file contains NUL bytes: ${path}`);
  try {
    decoder.decode(content);
  } catch {
    fail(`listed file is not valid UTF-8: ${path}`);
  }
  if (content.includes(Buffer.from("\r\n"))) fail(`listed file contains CRLF: ${path}`);

  const pathBytes = Buffer.from(path, "utf8");
  const pathLength = Buffer.alloc(4);
  pathLength.writeUInt32BE(pathBytes.length);
  const contentLength = Buffer.alloc(8);
  contentLength.writeBigUInt64BE(BigInt(content.length));
  hash.update(pathLength);
  hash.update(pathBytes);
  hash.update(contentLength);
  hash.update(content);
}

process.stdout.write(
  `${JSON.stringify(
    {
      manifest_version: manifest.version,
      manifest_path: MANIFEST_PATH,
      algorithm: "sha256",
      included_file_count: files.length,
      sha256: hash.digest("hex"),
      hash_definition: manifest.hash_definition,
      exclusion_rules: manifest.exclusion_rules,
      explicit_runtime_database_fixtures: [...explicitDatabaseFixtures],
      excluded_git_candidates: excludedGitCandidates.sort((a, b) =>
        bytewisePathOrder(a.path, b.path),
      ),
    },
    null,
    2,
  )}\n`,
);
