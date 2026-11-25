/** GitHub release discovery and bounded, verified compiled ZIP extraction. */
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

export const DEFAULT_REPO = "grizzly2005/bidirectional-bridge-claude-codex";
const MAX_FEED = 4 * 1024 * 1024;
const MAX_ASSET = 256 * 1024 * 1024;
const MAX_UNPACKED = 512 * 1024 * 1024;
const MAX_ENTRY = 64 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const HEX = /^[0-9a-f]{64}$/u;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;
const ALLOWED_HOSTS = new Set(["api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const MAX_REDIRECTS = 5;

export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
export function parseVersion(value) {
  const match = SEMVER.exec(String(value ?? ""));
  if (!match) throw new Error(`invalid semantic version: ${value}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null };
}
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (const key of ["major", "minor", "patch"]) if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return Math.sign(a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true }));
}

function safeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password) throw new Error("release URL must use an allowed HTTPS host");
  return url;
}
export async function boundedFetch(url, limit, options = {}) {
  let current = safeUrl(url);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const accept = options.accept ?? "application/octet-stream";
  const token = options.githubToken ?? process.env.GITHUB_TOKEN;
  let sameOriginAuth = Boolean(token);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = { "User-Agent": "bidirectional-bridge-updater", Accept: accept };
    if (sameOriginAuth && token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(current.href, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (response.status >= 300 && response.status < 400) {
      response.body?.cancel?.().catch(() => {});
      const location = response.headers.get("location");
      if (!location || hop === MAX_REDIRECTS) throw new Error("GitHub release redirect invalid or exceeded limit");
      const next = safeUrl(new URL(location, current).href);
      if (next.hostname !== current.hostname) sameOriginAuth = false;
      current = next;
      continue;
    }
    if (!response.ok) throw new Error(`GitHub release request failed: HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > limit) throw new Error("release response exceeds size limit");
    const reader = response.body.getReader();
    const chunks = []; let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) throw new Error("release response exceeds size limit");
        chunks.push(value);
      }
    } finally { reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks, total);
  }
  throw new Error("GitHub release redirect exceeded limit");
}
export async function defaultFetchJson(url, options = {}) {
  return JSON.parse((await boundedFetch(url, MAX_FEED, { ...options, accept: "application/vnd.github+json" })).toString("utf8"));
}
export async function defaultDownloadFile(url, _name, options = {}) {
  return boundedFetch(url, MAX_ASSET, { ...options, accept: "application/octet-stream" });
}

export async function getReleases(options = {}) {
  if (options.feedFile) {
    const bytes = readFileSync(options.feedFile);
    if (bytes.length > MAX_FEED) throw new Error("release feed exceeds size limit");
    const feed = JSON.parse(bytes.toString("utf8"));
    return Array.isArray(feed) ? feed : feed.releases;
  }
  const repo = options.repo ?? DEFAULT_REPO;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) throw new Error("invalid GitHub repository");
  const feed = await (options.fetchJson ?? defaultFetchJson)(`https://api.github.com/repos/${repo}/releases`);
  if (!Array.isArray(feed)) throw new Error("invalid GitHub release feed");
  return feed;
}
export function selectRelease(releases, options = {}) {
  if (!Array.isArray(releases)) throw new Error("invalid release feed");
  const eligible = releases.filter((release) => !release.draft && (options.includePrerelease || !release.prerelease) && typeof release.tag_name === "string")
    .filter((release) => { try { parseVersion(release.tag_name); return true; } catch { return false; } });
  if (options.tag) return eligible.find((release) => release.tag_name === options.tag) ?? null;
  return eligible.sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] ?? null;
}
export function releaseAssetName(version) { return `bidirectional-bridge-${version}-compiled.zip`; }
async function assetBytes(release, name, options) {
  if (options.assetsDir) {
    if (basename(name) !== name) throw new Error("unsafe asset name");
    const bytes = readFileSync(join(options.assetsDir, name));
    if (bytes.length > MAX_ASSET) throw new Error("release asset exceeds size limit");
    return bytes;
  }
  const asset = release.assets?.find((entry) => entry.name === name);
  if (!asset?.browser_download_url) throw new Error(`missing release asset: ${name}`);
  safeUrl(asset.browser_download_url);
  const received = await (options.downloadFile ?? defaultDownloadFile)(asset.browser_download_url, name);
  const bytes = Buffer.isBuffer(received) ? received : received instanceof Uint8Array ? Buffer.from(received) : readFileSync(received);
  if (bytes.length > MAX_ASSET) throw new Error("release asset exceeds size limit");
  return bytes;
}
export function parseSums(bytes) {
  const text = bytes.toString("utf8");
  const sums = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(line);
    if (!match || sums.has(match[2])) throw new Error("invalid SHA256SUMS.txt");
    sums.set(match[2], match[1]);
  }
  if (sums.size === 0) throw new Error("empty SHA256SUMS.txt");
  return sums;
}
function verifyAsset(name, bytes, sums) {
  if (!sums.has(name) || sha256(bytes) !== sums.get(name)) throw new Error(`SHA-256 mismatch: ${name}`);
}
export function validateManifest(manifest, release) {
  const version = parseVersion(release.tag_name);
  const expected = `${version.major}.${version.minor}.${version.patch}${version.prerelease ? `-${version.prerelease}` : ""}`;
  if (manifest?.schema_version !== 1 || manifest.version !== expected || manifest.tag !== release.tag_name || !manifest.files || typeof manifest.files !== "object") throw new Error("invalid RELEASE.json identity");
  if (!Number.isSafeInteger(manifest.database_schema_version) || manifest.database_schema_version < 0 || typeof manifest.protocol_version !== "string") throw new Error("invalid RELEASE.json compatibility fields");
  for (const [name, digest] of Object.entries(manifest.files)) if (!safeMember(name) || !HEX.test(digest)) throw new Error(`invalid RELEASE.json file: ${name}`);
  return manifest;
}
export async function fetchReleaseAssets(release, options = {}, includeZip = false) {
  const version = release.tag_name.replace(/^v/u, "");
  const sums = parseSums(await assetBytes(release, "SHA256SUMS.txt", options));
  const manifestBytes = await assetBytes(release, "RELEASE.json", options);
  verifyAsset("RELEASE.json", manifestBytes, sums);
  const manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")), release);
  const result = { manifest, sums, manifestBytes, zipName: releaseAssetName(version) };
  if (includeZip) {
    result.zipBytes = await downloadVerifiedZip(release, result, options);
  }
  return result;
}
export async function downloadVerifiedZip(release, assets, options = {}) {
  const zipBytes = await assetBytes(release, assets.zipName, options);
  verifyAsset(assets.zipName, zipBytes, assets.sums);
  return zipBytes;
}
export function satisfiesNode(requirement, runtime = process.versions.node) {
  const match = /^>=\s*(\d+\.\d+\.\d+)$/u.exec(String(requirement));
  return Boolean(match && compareVersions(runtime, match[1]) >= 0);
}
export function assessCompatibility(manifest, context = {}) {
  const currentSchema = context.currentSchemaVersion;
  const currentProtocol = context.currentProtocolVersion;
  if (!satisfiesNode(manifest.node_requirement, context.nodeVersion) ||
      (currentProtocol && parseVersion(currentProtocol).major !== parseVersion(manifest.protocol_version).major) ||
      (currentSchema !== null && currentSchema !== undefined && manifest.database_schema_version < currentSchema)) return "breaking_or_incompatible";
  if (currentSchema !== null && currentSchema !== undefined && manifest.database_schema_version > currentSchema) return "migration_required";
  return "compatible";
}

function safeMember(name) {
  return typeof name === "string" && name.length > 0 && !name.includes("\\") && !name.includes("\0") && !name.startsWith("/") &&
    !/^[A-Za-z]:/u.test(name) && name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Read the central directory; reject ambiguous or unsafe members before writing any file. */
export function extractVerifiedZip(zip, manifest, destination) {
  if (!Buffer.isBuffer(zip) || zip.length > MAX_ASSET) throw new Error("invalid ZIP size");
  const prefix = `bidirectional-bridge-${manifest.version}/`;
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("invalid ZIP central directory");
  const count = zip.readUInt16LE(eocd + 10), offset = zip.readUInt32LE(eocd + 16), length = zip.readUInt32LE(eocd + 12);
  if (count > MAX_ENTRIES || zip.readUInt16LE(eocd + 8) !== count || offset + length > eocd || zip.readUInt16LE(eocd + 4) !== 0 || zip.readUInt16LE(eocd + 6) !== 0) throw new Error("unsupported ZIP directory");
  const entries = []; const names = new Set(); let cursor = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid ZIP entry");
    const flags = zip.readUInt16LE(cursor + 8), method = zip.readUInt16LE(cursor + 10), crc = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20), uncompressed = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28), extraLength = zip.readUInt16LE(cursor + 30), commentLength = zip.readUInt16LE(cursor + 32);
    const external = zip.readUInt32LE(cursor + 38), localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    const mode = external >>> 16;
    if (!name.startsWith(prefix) || (name !== prefix && !safeMember(name.slice(prefix.length))) || names.has(name) || flags & 1 || ![0, 8].includes(method) || (mode & 0o170000) === 0o120000) throw new Error(`unsafe ZIP entry: ${name}`);
    names.add(name);
    if (name.endsWith("/")) continue;
    total += uncompressed;
    if (uncompressed > MAX_ENTRY || total > MAX_UNPACKED || compressed > MAX_ASSET || localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("ZIP size or header violation");
    const localNameLength = zip.readUInt16LE(localOffset + 26), localExtraLength = zip.readUInt16LE(localOffset + 28);
    if (zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8") !== name) throw new Error("ZIP filename mismatch");
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start + compressed > zip.length) throw new Error("truncated ZIP entry");
    const content = method === 0 ? zip.subarray(start, start + compressed) : inflateRawSync(zip.subarray(start, start + compressed), { maxOutputLength: MAX_ENTRY });
    if (content.length !== uncompressed || crc32(content) !== crc) throw new Error(`ZIP content mismatch: ${name}`);
    const relative = name.slice(prefix.length);
    const expected = relative === "RELEASE.json" ? null : manifest.files[relative];
    if (relative !== "RELEASE.json" && !expected) throw new Error(`unlisted ZIP file: ${relative}`);
    if (expected && sha256(content) !== expected) throw new Error(`RELEASE.json.files mismatch: ${relative}`);
    entries.push({ relative, content });
  }
  if (cursor !== offset + length || !entries.some((entry) => entry.relative === "RELEASE.json")) throw new Error("incomplete ZIP directory");
  for (const name of Object.keys(manifest.files)) if (!entries.some((entry) => entry.relative === name)) throw new Error(`missing ZIP file: ${name}`);
  const embedded = entries.find((entry) => entry.relative === "RELEASE.json");
  if (embedded.content.toString("utf8") !== `${JSON.stringify(manifest, null, 2)}\n` && sha256(embedded.content) !== sha256(Buffer.from(JSON.stringify(manifest)))) {
    // Compare parsed content because the publisher sorts keys and uses indentation.
    if (JSON.stringify(JSON.parse(embedded.content.toString("utf8"))) !== JSON.stringify(manifest)) throw new Error("embedded RELEASE.json mismatch");
  }
  for (const { relative, content } of entries) {
    const target = resolve(destination, ...relative.split("/"));
    if (!target.startsWith(resolve(destination) + (process.platform === "win32" ? "\\" : "/"))) throw new Error("ZIP path escapes staging");
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content, { flag: "wx" });
  }
  return { file_count: entries.length, bytes: total };
}
