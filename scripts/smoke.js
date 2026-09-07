#!/usr/bin/env node
/*
 * End-to-end check against a real `pi --mode rpc` process, without VS Code:
 *  - the process wrapper correlates responses,
 *  - the conversation reducer builds a sensible message list from streamed events,
 *  - reloading the session through get_messages reproduces the same shape.
 * Costs one small model call. Run with `npm run smoke`.
 */
const path = require('path');
const { PiProcess, resolvePiCommand, augmentedEnv } = require('../dist/pi-process');
const { Conversation } = require('../dist/conversation');

const cwd = process.cwd();
const env = augmentedEnv();
const command = resolvePiCommand(process.env.PI_COMMAND, env);
const model = process.env.PI_MODEL ? ['--model', process.env.PI_MODEL] : [];
console.log(`pi: ${command}`);

const proc = new PiProcess({ command, args: ['--mode', 'rpc', ...model], cwd, env });
const conv = new Conversation(cwd);
const seen = new Set();
let uiRequests = 0;

proc.on('event', e => {
  seen.add(e.type);
  if (e.type === 'extension_ui_request') {
    uiRequests++;
    if (['select', 'confirm', 'input', 'editor'].includes(e.method)) proc.respondUi(e.id, { cancelled: true });
    return;
  }
  conv.apply(e);
});
proc.on('stderr', t => process.stderr.write(`[stderr] ${t}`));
proc.on('error', err => fail(`spawn failed: ${err.message}`));

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  proc.kill();
  process.exit(1);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
  console.log(`ok - ${msg}`);
}

function waitSettled() {
  return new Promise(resolve => {
    const h = e => {
      if (e.type === 'agent_settled') {
        proc.off('event', h);
        resolve();
      }
    };
    proc.on('event', h);
  });
}

(async () => {
  const state = await proc.request({ type: 'get_state' });
  assert(state.success && state.data.sessionFile, 'get_state returns a session file');
  const models = await proc.request({ type: 'get_available_models' });
  assert(models.success && models.data.models.length > 0, `models listed (${models.data.models.length})`);
  const levels = await proc.request({ type: 'get_available_thinking_levels' });
  assert(levels.success && Array.isArray(levels.data.levels), `thinking levels: ${levels.data.levels.join(',')}`);

  // Direct bash into context.
  const bashId = conv.addBash('printf smoke-bash');
  const bash = await proc.request({ id: `bash-${bashId}`, type: 'bash', command: 'printf smoke-bash' });
  assert(bash.success && bash.data.output.includes('smoke-bash'), 'bash command runs and returns output');
  conv.finishBash(bashId, bash.data.output, bash.data.exitCode, false);

  // A prompt that forces a tool call so the reducer sees the whole tool lifecycle.
  const settled = waitSettled();
  conv.addUser('smoke prompt');
  const prompt = await proc.request({
    type: 'prompt',
    message: 'Use the bash tool to run exactly `echo pi-smoke-ok` and then reply with the single word DONE. Do nothing else.',
  });
  assert(prompt.success, 'prompt accepted');
  await Promise.race([settled, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for agent_settled')), 120000))]).catch(e => fail(e.message));

  const roles = conv.messages.map(m => m.role);
  console.log(`events: ${[...seen].sort().join(' ')}`);
  console.log(`messages: ${roles.join(' > ')}`);
  assert(roles.includes('assistant'), 'assistant message produced');
  const tool = conv.messages.find(m => m.role === 'tool');
  assert(tool && tool.status === 'done' && /pi-smoke-ok/.test(tool.output), 'tool message captured with output');
  const last = [...conv.messages].reverse().find(m => m.role === 'assistant');
  assert(last && last.status === 'done' && /DONE/i.test(last.text), `assistant finished: ${JSON.stringify(last && last.text.slice(0, 60))}`);
  assert(!conv.streaming, 'streaming flag cleared after agent_settled');

  // Reload through get_messages and compare shapes.
  const msgs = await proc.request({ type: 'get_messages' });
  assert(msgs.success, 'get_messages works');
  const reloaded = new Conversation(cwd);
  reloaded.load(msgs.data.messages);
  const rroles = reloaded.messages.map(m => m.role);
  console.log(`reloaded: ${rroles.join(' > ')}`);
  assert(rroles.filter(r => r === 'tool').length === roles.filter(r => r === 'tool').length, 'reloaded history has the same tool calls');
  assert(rroles.includes('bash'), 'reloaded history keeps the direct bash execution');

  const stats = await proc.request({ type: 'get_session_stats' });
  assert(stats.success && stats.data.tokens, `session stats: ${stats.data.tokens.input} in / ${stats.data.tokens.output} out, $${stats.data.cost}`);
  console.log(`extension UI requests seen: ${uiRequests}`);
  console.log(`session: ${state.data.sessionFile}`);
  proc.kill();
  process.exit(0);
})().catch(err => fail(err.stack || err.message));
