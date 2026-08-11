#!/usr/bin/env node
/**
 * Structural probe of the real Claude Code stream-json protocol.
 *
 * Runs one bounded, read-only `claude -p` and prints a REDACTED digest of every frame it
 * emitted: frame type/subtype, the full key path of every field, and — for numeric and
 * boolean fields only — the value. Strings are replaced by `<string:len>` and uuids by
 * `<uuid>`, so the output can be pasted into an audit without leaking prompt text,
 * conversation content, session ids, or paths.
 *
 * This exists because the telemetry collector must be written against the protocol as the
 * installed runtime actually emits it, not against documentation or a model's description
 * of it. Re-run it after a Claude Code upgrade to see whether the mapping still holds.
 *
 * Usage:
 *   node claude/claude-side/scripts/probe-claude-frames.mjs [--claude-bin claude] [--model m]
 *                                                          [--out <path>]
 *
 * The probe has no unredacted output mode: runtime frames are never retained or written to
 * disk, and `--out` mirrors only the same redacted digest that goes to stdout.
 */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync, writeSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

/**
 * Resolve a bare command name to a real file.
 *
 * `spawn` without `shell` does not consult PATHEXT, so on Windows a bare `claude` — which
 * is installed as `claude.cmd`/`claude.exe` — fails with ENOENT. Resolving here (rather
 * than setting `shell: true`) keeps the prompt out of a command line an interpreter would
 * re-parse, which matters because the prompt contains quotes, backticks and newlines.
 */
function resolveCommand(cmd) {
  if (isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) return cmd;
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return cmd;
}

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const bin = flag("--claude-bin", "claude");
const model = flag("--model", undefined);
const outPath = flag("--out", undefined);
const prompt =
  flag("--prompt", "Reply with exactly the word PROBE_OK and nothing else. Do not use any tool.");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Redact a leaf: keep shape and numbers, drop every free-form string. */
function redactLeaf(v) {
  if (v === null) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (UUID_RE.test(v)) return "<uuid>";
    if (v.length <= 24 && /^[A-Za-z0-9._:-]+$/.test(v)) return v; // enum-ish tokens are safe
    return `<string:${v.length}>`;
  }
  return v;
}

function digest(node, prefix, out) {
  if (Array.isArray(node)) {
    out.push(`${prefix}[] len=${node.length}`);
    if (node.length > 0) digest(node[0], `${prefix}[0]`, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      digest(node[k], prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  out.push(`${prefix} = ${JSON.stringify(redactLeaf(node))}`);
}

const args = [
  "-p",
  prompt,
  "--output-format",
  "stream-json",
  "--verbose",
  "--max-turns",
  "1",
  "--permission-mode",
  "plan",
];
if (model) args.push("--model", model);

/**
 * Emit the digest.
 *
 * Written with `fs.writeSync` rather than `console.log`: when stdout is a pipe (which it is
 * under `npm run`, or any wrapper that captures output) writes are asynchronous, and a
 * process that ends promptly afterwards can lose every buffered line. `--out` additionally
 * mirrors the digest to a file, which survives a supervisor killing the process tree.
 */
const digestLines = [];
const say = (line = "") => {
  digestLines.push(line);
  try {
    writeSync(1, `${line}\n`);
  } catch {
    /* stdout may be closed; the --out mirror is the durable copy */
  }
};
const finish = (code) => {
  if (outPath) writeFileSync(outPath, `${digestLines.join("\n")}\n`);
  process.exitCode = code;
};

const started = Date.now();
const resolved = resolveCommand(bin);
const child = spawn(resolved, args, { stdio: ["ignore", "pipe", "pipe"] });
child.on("error", (err) => {
  say(`# claude frame probe`);
  say(`spawn_failed=${err.code ?? "unknown"} resolved_ext=${extname(resolved) || "<none>"}`);
  finish(1);
});

let buffer = "";
const frames = [];
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
let stderr = "";
child.stderr.on("data", (c) => (stderr += c));
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      console.log(`[non-json stdout line, ${line.length} chars]`);
    }
  }
});

child.on("close", (code, signal) => {
  say(`# claude frame probe`);
  say(`exit_code=${code} signal=${signal ?? "none"} wall_ms=${Date.now() - started}`);
  say(`frame_count=${frames.length}`);
  if (stderr.trim()) say(`stderr_bytes=${stderr.length}`);
  say();

  frames.forEach((f, idx) => {
    const head = `${f.type}${f.subtype ? `/${f.subtype}` : ""}`;
    say(`--- frame ${idx}: ${head} ---`);
    const out = [];
    digest(f, "", out);
    for (const line of out) say(`  ${line}`);
    say();
  });

  finish(code ?? 1);
});
