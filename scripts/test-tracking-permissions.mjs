#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, statSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrackingCoordinator } from "../shared/mcp-server-core/dist/tracking.js";

if (process.platform === "win32") {
  process.stdout.write("POSIX permission check requires WSL/Linux/macOS; Windows inherits workspace ACLs.\n");
} else {
  const workspace = mkdtempSync(join(tmpdir(), "bridge-tracking-permissions-"));
  const previousUmask = process.umask(0o022);
  let tracking;
  try {
    const bridge = join(workspace, ".bridge"); mkdirSync(bridge); chmodSync(bridge, 0o755);
    tracking = new TrackingCoordinator({ workspaceRoot: workspace, principal: "permission-test" });
    tracking.open();
    assert.equal(statSync(tracking.statePath).mode & 0o777, 0o600);
    tracking.close();
    chmodSync(tracking.statePath, 0o644);
    tracking = new TrackingCoordinator({ workspaceRoot: workspace, principal: "permission-test" });
    tracking.open();
    assert.equal(statSync(tracking.statePath).mode & 0o777, 0o600);
    tracking.close();
    const alternate = join(workspace, "alternate.db");
    const target = join(workspace, "untouched.txt"); writeFileSync(target, "preserve", { mode: 0o644 });
    symlinkSync(target, `${alternate}.tracking-ui.sqlite`);
    tracking = new TrackingCoordinator({ workspaceRoot: workspace, databasePath: alternate, principal: "permission-test" });
    assert.throws(() => tracking.open(), /UNSAFE_TRACKING_STATE/u);
    assert.equal(statSync(target).mode & 0o777, 0o644);
    process.stdout.write("3 POSIX permission checks passed (existing0755 directory, umask022, symlink refusal).\n");
  } finally {
    tracking?.close(); process.umask(previousUmask);
    assert(workspace.startsWith(join(tmpdir(), "bridge-tracking-permissions-")));
    rmSync(workspace, { recursive: true, force: true });
  }
}
