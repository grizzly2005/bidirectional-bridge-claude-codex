#!/usr/bin/env node
// Opt-in real-runtime integration harness. No application tests or source edits.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CodexAppServerProcessClient, parseWslWorkspace } from "../dist/index.js";

const argv = process.argv.slice(2);
const option = name => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
const workspace = option("--workspace");
const executable = option("--codex-wsl-executable");
const output = resolve(option("--output") ?? ".bridge/windows-wsl-smoke.json");
assert.equal(process.platform, "win32", "This smoke exercises a Windows-hosted bridge");
assert(workspace && executable, "Supply --workspace <WSL UNC> --codex-wsl-executable <absolute Linux CLI>");
const selected = parseWslWorkspace(workspace);
assert(selected, "A WSL UNC workspace is required");
const results = [];
const record = (name, detail, passed = true) => {
  results.push({ name, passed, ...detail });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ runtime: executable, distribution: selected.distribution, workspace,
    checks: results, model_requested: argv.includes("--invoke") }, null, 2));
  process.stdout.write(`${passed === null ? "NOT_RUN" : passed ? "PASS" : "FAIL"} ${name}\n`);
};
const wsl = args => {
  const result = spawnSync(resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe"),
    ["--distribution", selected.distribution, "--exec", ...args], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
};
const unc = path => `\\\\wsl.localhost\\${selected.distribution}${path.replaceAll("/", "\\")}`;
const options = cwd => ({ cwd, wsl_executable: executable });
const config = { mcp_servers: { bridge: { enabled: false } } };

async function inspectSession(cwd, sandbox, verify) {
  const client = new CodexAppServerProcessClient(options(cwd));
  const abort = new AbortController();
  let checked = false;
  try {
    const probe = await client.probe();
    assert.equal(probe.state, "READY", probe.detail);
    await assert.rejects(client.start({ cwd, sandbox, approval_policy: "never", config,
      prompt: "BRIDGE_SMOKE: no model turn should start", timeout_ms: 15000, signal: abort.signal,
      on_execution_handle: async id => {
        // Internal transport access is confined to this integration harness. Execute with
        // the exact policy confirmed by thread/start, never thread/shellCommand (unsandboxed).
        const settings = client.wslTurnSettings.get(id);
        assert.equal(settings.cwd, parseWslWorkspace(cwd).path);
        assert.deepEqual(settings.runtimeWorkspaceRoots, [settings.cwd]);
        const command = async args => client.request("command/exec", { command: args, cwd: settings.cwd,
          sandboxPolicy: settings.sandboxPolicy, timeoutMs: 5000 }, 7000);
        await verify(command, settings, probe);
        checked = true;
        abort.abort();
      },
    }), error => error.code === "TIMEOUT" && error.message === "turn aborted before start" && checked);
  } finally {
    await client.close();
  }
}

try {
  record("pinned Linux runtime", { version: wsl([executable, "--version"]) });
  await inspectSession(workspace, "read-only", async (command, settings, probe) => {
    const result = await command(["/bin/pwd"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), selected.path);
    record("selected repository: sandboxed pwd", { result, session: settings, runtime: probe.detail });
  });

  // A synthetic repository tests writes. Nothing is copied from the selected application.
  const home = wsl(["printenv", "HOME"]);
  assert(home.startsWith("/") && home !== "/");
  const scratch = wsl(["mktemp", "--directory", `${home}/.bridge-codex-smoke.XXXXXX`]);
  assert(scratch.startsWith(`${home}/.bridge-codex-smoke.`));
  const root = `${scratch}/workspace with spaces`;
  wsl(["mkdir", root]);
  wsl(["git", "init", "--quiet", root]);
  const marker = "BRIDGE_WINDOWS_WSL_MAPPING_OK\n";
  writeFileSync(`${unc(root)}\\marker.txt`, marker);
  const code = `const fs=require('fs');const path=require('path');const assert=require('assert');
    const mode=process.argv[1];assert.equal(fs.readFileSync('marker.txt','utf8'),${JSON.stringify(marker)});
    let inside=false,outside=false;
    try{fs.writeFileSync('worker.txt','BRIDGE_WRITE_OK');inside=true}catch(e){assert(['EACCES','EPERM','EROFS'].includes(e.code),e.message)}
    try{fs.writeFileSync(path.resolve('..','outside.txt'),'UNEXPECTED');outside=true}catch(e){assert(['EACCES','EPERM','EROFS'].includes(e.code),e.message)}
    assert.equal(inside,mode==='workspace-write');assert.equal(outside,false);
    console.log(JSON.stringify({cwd:process.cwd(),marker_read:true,inside_write:inside,outside_write:outside}));`;
  for (const sandbox of ["read-only", "workspace-write"]) {
    await inspectSession(unc(root), sandbox, async (command, settings) => {
      const result = await command(["node", "-e", code, sandbox]);
      assert.equal(result.exitCode, 0, result.stderr);
      const observed = JSON.parse(result.stdout.trim());
      assert.equal(observed.cwd, root);
      record(`synthetic repository: ${sandbox} boundary`, { result: observed, session: settings, exit_code: result.exitCode });
    });
  }
  assert.equal(readFileSync(`${unc(root)}\\worker.txt`, "utf8"), "BRIDGE_WRITE_OK");
  record("artifact correspondence through UNC", { path: `${unc(root)}\\worker.txt`, content: "BRIDGE_WRITE_OK" });

  if (argv.includes("--invoke")) {
    let handle;
    const client = new CodexAppServerProcessClient(options(unc(root)));
    try {
      const result = await client.start({ cwd: unc(root), sandbox: "read-only", approval_policy: "never", config,
        prompt: "Reply exactly BRIDGE_MODEL_SMOKE_OK. Do not use any tools or read files.", timeout_ms: 20000,
        signal: new AbortController().signal, on_execution_handle: async id => { handle = id; } });
      assert.equal(result.content.trim(), "BRIDGE_MODEL_SMOKE_OK");
      record("model turn", { telemetry: result.telemetry });
    } catch (error) {
      record("model turn", { code: error.code, message: error.message.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/giu, "[thread]"),
        runtime_stop_confirmed: error.details?.runtime_stop_confirmed,
        runtime_failure: error.details?.runtime_telemetry?.runtime_failure }, false);
      process.exitCode = 1;
    } finally { await client.close(); }
    if (handle) {
      const resumed = new CodexAppServerProcessClient(options(unc(root)));
      const abort = new AbortController();
      let matched = false;
      try {
        await assert.rejects(resumed.reply({ thread_id: handle, cwd: unc(root), sandbox: "read-only", approval_policy: "never", config,
          prompt: "No model continuation should start", timeout_ms: 15000, signal: abort.signal,
          on_execution_handle: async id => { assert.equal(id, handle); matched = true; abort.abort(); },
        }), error => error.code === "TIMEOUT" && error.message === "turn aborted before start" && matched);
        record("same persisted child after App Server restart", { matched, handle_sha256: createHash("sha256").update(handle).digest("hex") });
      } finally { await resumed.close(); }
    }
  } else {
    record("model turn and persisted-child resume", { executed: false, reason: "Use --invoke with an authenticated Linux Codex profile" }, null);
  }
} catch (error) {
  record("smoke stopped", { message: error.message }, false);
  process.exitCode = 1;
}
process.stdout.write(`Evidence: ${output}\n`);
