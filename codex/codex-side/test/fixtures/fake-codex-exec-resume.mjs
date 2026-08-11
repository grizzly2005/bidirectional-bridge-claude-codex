import { stdin, stdout } from "node:process";

const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_EXEC_MODE ?? "normal";

if (args[0] !== "exec" || args[1] !== "resume" || !args.includes("--json")) {
  process.stderr.write(`unexpected argv: ${JSON.stringify(args)}\n`);
  process.exit(9);
}

const threadId = args.at(-2);
if (typeof threadId !== "string" || threadId.length === 0 || args.at(-1) !== "-") {
  process.stderr.write("missing persisted thread id or stdin prompt marker\n");
  process.exit(9);
}

let prompt = "";
stdin.setEncoding("utf8");
for await (const chunk of stdin) prompt += chunk;

if (mode === "hang") {
  await new Promise(() => {});
}
if (mode === "fail") {
  process.stderr.write("persisted session is unavailable\n");
  process.exit(7);
}

const content =
  process.env.FAKE_CODEX_EXEC_CONTENT ??
  JSON.stringify({
    status: "PARTIAL",
    summary: `resumed ${prompt}`,
    changed_scope: [],
    artifacts: [],
    commit_or_diff: null,
    verification_results: [],
    remaining_risks: [],
    recommended_next_action: "none",
  });

stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: threadId })}\n`);
stdout.write(
  `${JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: content },
  })}\n`,
);
stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
