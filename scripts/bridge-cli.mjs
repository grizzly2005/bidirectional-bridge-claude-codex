#!/usr/bin/env node
/**
 * Unified `bridge` CLI entrypoint:
 *   bridge setup   [...]  — install/discover central bridge and wire chosen project clients
 *   bridge doctor  [...]  — verify each client, workspace, SQLite DB, WSL binary/auth, and stale sessions
 *   bridge update  [...]  — check/verify/smoke-test/activate GitHub releases and report affected projects
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SETUP_HELP, formatSetupReport, parseSetupArgs, runBridgeSetup, setupExitCode } from "./cli/setup.mjs";
import { DOCTOR_CLI_HELP, doctorExitCode, formatDoctorReport, parseDoctorCliArgs, runBridgeDoctor } from "./cli/doctor.mjs";
import { UPDATE_HELP, formatUpdateReport, parseUpdateArgs, runBridgeUpdate, updateExitCode } from "./cli/update.mjs";

const cliPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(cliPath), "..");

export const BRIDGE_CLI_HELP = `bridge — unified installation, diagnostic and release update CLI

Usage:
  bridge setup [options]    Find or install the central bridge and wire project clients (claude, codex, gemini)
  bridge doctor [options]   Verify workspace, SQLite DB, caller identity, WSL Codex and running MCP sessions
  bridge update [options]   Check GitHub Releases, affected projects, migrations and apply verified updates
  bridge --version          Print the installed bridge version
  bridge --help             Show this help

Run \`bridge <command> --help\` for command-specific flags.
`;

function readBridgeVersion() {
  try {
    return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function runBridgeCli(argv, io = { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd() }) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    io.stdout.write(BRIDGE_CLI_HELP);
    return 0;
  }
  if (subcommand === "--version" || subcommand === "-v" || subcommand === "version") {
    io.stdout.write(`${readBridgeVersion()}\n`);
    return 0;
  }
  switch (subcommand) {
    case "setup": {
      let args;
      try { args = parseSetupArgs(rest, io.cwd); }
      catch (error) { io.stderr.write(`bridge setup: ${error.message}; run --help\n`); return 2; }
      if (args.help) { io.stdout.write(SETUP_HELP); return 0; }
      const report = await runBridgeSetup(args);
      io.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatSetupReport(report));
      return setupExitCode(report);
    }
    case "doctor": {
      let args;
      try { args = parseDoctorCliArgs(rest, io.cwd); }
      catch (error) { io.stderr.write(`bridge doctor: ${error.message}; run --help\n`); return 2; }
      if (args.help) { io.stdout.write(DOCTOR_CLI_HELP); return 0; }
      const report = await runBridgeDoctor(args);
      io.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
      return doctorExitCode(report);
    }
    case "update": {
      let args;
      try { args = parseUpdateArgs(rest, io.cwd); }
      catch (error) { io.stderr.write(`bridge update: ${error.message}; run --help\n`); return 2; }
      if (args.help) { io.stdout.write(UPDATE_HELP); return 0; }
      const report = await runBridgeUpdate(args);
      io.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatUpdateReport(report));
      return updateExitCode(report, args);
    }
    default:
      io.stderr.write(`bridge: commande inconnue '${subcommand}'. Utiliser setup, doctor ou update (voir bridge --help).\n`);
      return 2;
  }
}

function canonical(path) {
  try { return realpathSync(resolve(path)); } catch { return resolve(path); }
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(cliPath)) {
  runBridgeCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => { process.stderr.write(`bridge: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; },
  );
}
