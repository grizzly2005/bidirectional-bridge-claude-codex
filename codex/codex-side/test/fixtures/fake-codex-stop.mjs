import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = process.argv[2];
const mode = process.argv[3];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const turns = new Map();
let nextThread = 0;
let nextTurn = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const response = value => send({ id: m.id, result: value });
  if (m.method === 'initialize') return response({ userAgent: 'Codex/0.147.0' });
  if (m.method === 'config/read') return response({ config: { model: 'fixture', model_provider: 'openai' } });
  if (m.method === 'model/list') return response({ data: [{ model: 'fixture', isDefault: true }], nextCursor: null });
  if (m.method === 'thread/start') return response({ thread: { id: 'thread_' + ++nextThread }, model: 'fixture' });
  if (m.method === 'turn/start') {
    const threadId = m.params.threadId;
    const turn = { id: 'turn_' + ++nextTurn, status: 'inProgress', items: [] };
    const timer = setInterval(() => appendFileSync(log, `write:${threadId}:${turn.id}\n`), 10);
    turns.set(turn.id, { threadId, turn, timer });
    if (mode === 'invalid-early') send({ method: 'turn/completed', params: { threadId, turn } });
    if (mode === 'late-start') setTimeout(() => send({ method: 'turn/started', params: { threadId, turn } }), 350);
    else send({ method: 'turn/started', params: { threadId, turn } });
    if (mode !== 'lost-start' && mode !== 'late-start') response({ turn });
    return;
  }
  if (m.method === 'turn/interrupt') {
    const entry = turns.get(m.params.turnId);
    appendFileSync(log, `interrupt:${m.params.threadId}:${m.params.turnId}\n`);
    if (!entry || entry.threadId !== m.params.threadId) return send({ id: m.id, error: { code: -1, message: 'wrong turn' } });
    response({});
    if (mode === 'ignore-stop') return;
    if (mode === 'invalid-status' || mode === 'invalid-early') {
      send({ method: 'turn/completed', params: { threadId: entry.threadId, turn: { ...entry.turn, status: 'inProgress' } } });
      return;
    }
    setTimeout(() => {
      clearInterval(entry.timer);
      entry.turn.status = 'interrupted';
      appendFileSync(log, `stopped:${entry.threadId}:${entry.turn.id}\n`);
      send({ method: 'turn/completed', params: { threadId: entry.threadId, turn: entry.turn } });
      // A duplicate late notification must not resurrect a retired waiter.
      setTimeout(() => send({ method: 'turn/completed', params: { threadId: entry.threadId, turn: entry.turn } }), 20);
    }, 40);
    return;
  }
  send({ id: m.id, error: { code: -32601, message: 'unsupported' } });
});
