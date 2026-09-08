#!/usr/bin/env node
/*
 * Exercises the editor auto-context builder against a stubbed VS Code API, so the shape of what gets
 * appended to every prompt is pinned down without opening an editor.
 */
const Module = require('module');
const path = require('path');

let editor = null;
let diagnostics = [];
let config = { autoContext: 'selection', shareDiagnostics: true, contextFileMaxKb: 96 };

const contextKeys = {};
const notices = [];
const clipboard = { text: '' };
const vscodeStub = {
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  window: {
    get activeTextEditor() { return editor; },
    createStatusBarItem: () => ({ show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, show() { this.shown = true; }, dispose() {} }),
    showInformationMessage: (m) => { notices.push(m); return Promise.resolve(undefined); },
    showWarningMessage: (m) => { notices.push(m); return Promise.resolve(undefined); },
  },
  languages: { getDiagnostics: () => diagnostics },
  env: { clipboard: { writeText: async (t) => { clipboard.text = t; } } },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (config[k] !== undefined ? config[k] : d) }),
    workspaceFolders: [],
    asRelativePath: (uri) => (typeof uri === 'string' ? uri : uri.fsPath),
  },
  StatusBarAlignment: { Left: 1 },
  Uri: { file: p => ({ fsPath: p, scheme: 'file' }) },
  EventEmitter: class { constructor() { this.event = () => {}; } fire() {} },
  ThemeIcon: class {},
  ThemeColor: class { constructor(id) { this.id = id; } },
  TreeItem: class {},
  TreeItemCollapsibleState: {},
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: (cmd, key, value) => {
      if (cmd === 'setContext') contextKeys[key] = value;
    },
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

const { PiCodeProvider, timelineRow } = require('../dist/extension');
const provider = new PiCodeProvider({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} }, workspaceState: { get: () => undefined, update: async () => {} }, extensionUri: {} });
const build = (cwd, attached) => provider.editorContext(cwd, attached || []);

let failed = 0;
const ok = (cond, msg) => { if (!cond) failed++; console.log(`${cond ? 'ok  ' : 'FAIL'} - ${msg}`); };

const doc = (text, lang = 'ruby') => ({
  uri: { fsPath: '/repo/app/models/user.rb', scheme: 'file' },
  languageId: lang,
  getText: sel => text.split('\n').slice(sel.start.line, sel.end.line + 1).join('\n'),
});

ok(build('/repo') === '', 'no editor means no context');

editor = { document: doc('a\nb\nc'), selection: { isEmpty: true, active: { line: 41 }, start: { line: 41 }, end: { line: 41 } } };
let out = build('/repo');
ok(out.includes('app/models/user.rb:42') && out.includes('no selection'), `cursor position reported: ${out.split('\n')[0]}`);
ok(!out.includes('```'), 'nothing is inlined without a selection');

editor.selection = { isEmpty: false, active: { line: 1 }, start: { line: 0 }, end: { line: 1 } };
out = build('/repo');
ok(out.includes('app/models/user.rb:1-2') && out.includes('```ruby'), 'selection inlined with language');

diagnostics = [
  { severity: 0, range: { start: { line: 11, character: 4 } }, source: 'rubocop', message: 'Style/Foo:  bad\n  thing' },
  { severity: 3, range: { start: { line: 1, character: 0 } }, message: 'a hint' },
];
out = build('/repo');
ok(out.includes('12:5 error [rubocop] Style/Foo: bad thing'), 'errors listed with position and source, whitespace collapsed');
ok(!out.includes('a hint'), 'hints and info are not sent');

config.shareDiagnostics = false;
ok(!build('/repo').includes('rubocop'), 'diagnostics can be turned off');
config.shareDiagnostics = true;

config.autoContext = 'file';
ok(!build('/repo').includes('```'), 'file mode reports the path but never inlines the selection');
config.autoContext = 'off';
ok(build('/repo') === '', 'off means off');
config.autoContext = 'selection';

ok(build('/repo', ['/repo/app/models/user.rb']) === '', 'a file already attached by hand is not repeated');

// --- status bar readout ---
const status = provider.status;
const task = { id: 't1', name: 'Task 1', alive: true, conv: { streaming: false }, tier: {}, model: 'litellm/gpt-6-astra-max', stats: { cost: 0.42, contextUsage: { percent: 7 } } };
provider.tasks.set('t1', task);
provider.activeTaskId = 't1';

provider.renderStatus();
ok(status.text === '$(hubot) Pi $0.42', `idle status shows cost: ${status.text}`);
ok(String(status.tooltip).includes('gpt-6-astra-max') && String(status.tooltip).includes('7%'), 'tooltip carries model and context usage');

task.conv.streaming = true;
provider.renderStatus();
ok(status.text.startsWith('$(sync~spin)'), 'working status spins');

task.conv.streaming = false;
task.alive = false;
provider.renderStatus();
ok(status.text.includes('debug-disconnect') && !!status.backgroundColor, 'a dead pi is flagged in the status bar');

task.alive = true;
config.statusBar = false;
provider.renderStatus();
ok(status.visible === false, 'status bar can be turned off');
config.statusBar = true;

// --- files become chips, but only when they are text ---
const fsMod = require('fs');
const os = require('os');
const pathMod = require('path');
const tmp = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'pi-code-chip-'));
const textFile = pathMod.join(tmp, 'note.txt');
fsMod.writeFileSync(textFile, 'hello');
const binFile = pathMod.join(tmp, 'blob.bin');
fsMod.writeFileSync(binFile, Buffer.from([0x50, 0x4b, 0x03, 0x00, 0x04, 0xff]));
ok(provider.fileChip({ fsPath: textFile }).text === 'hello', 'a text file is inlined');
const binChip = provider.fileChip({ fsPath: binFile });
ok(/binary file/.test(binChip.text) && !binChip.text.includes('\u0000'), 'a binary file is named, not inlined');
config.contextFileMaxKb = 0;
ok(/too large/.test(provider.fileChip({ fsPath: textFile }).text), 'an oversized file is named, not inlined');
config.contextFileMaxKb = 96;
fsMod.rmSync(tmp, { recursive: true, force: true });

// --- posts reach both the sidebar and the editor tab ---
const seen = { view: [], panel: [] };
provider.view = { webview: { postMessage: m => seen.view.push(m) } };
provider.panel = { webview: { postMessage: m => seen.panel.push(m) } };
provider.post({ type: 'ping' });
ok(seen.view.length === 1 && seen.panel.length === 1, 'a post reaches the sidebar and the editor tab exactly once');
provider.view = undefined;
provider.post({ type: 'ping' });
ok(seen.panel.length === 2, 'a post still reaches the tab when the sidebar is closed');
provider.panel = undefined;

// --- finishing out of sight ---
const badges = [];
provider.view = { webview: { postMessage: () => {} }, visible: true, set badge(v) { badges.push(v); } };
provider.announceDone(task);
ok(provider.unseen.size === 0, 'a visible chat needs no badge');
provider.view.visible = false;
provider.announceDone(task);
ok(provider.unseen.size === 1 && badges[badges.length - 1] && badges[badges.length - 1].value === 1, 'finishing out of sight raises a badge');
config.notifyWhenDone = 'off';
provider.unseen.clear();
provider.announceDone(task);
ok(provider.unseen.size === 0, 'the notice can be turned off');
config.notifyWhenDone = 'badge';
provider.view = undefined;
provider.panel = undefined;

// --- palette context keys ---
task.alive = true;
task.sessionFile = '/tmp/session.jsonl';
task.conv.streaming = true;
provider.renderStatus();
ok(contextKeys['piCode.streaming'] === true && contextKeys['piCode.alive'] === true, 'a working task sets the streaming and alive keys');
ok(contextKeys['piCode.hasSession'] === true, 'a task with a session file sets hasSession');

task.conv.streaming = false;
task.alive = false;
provider.renderStatus();
ok(contextKeys['piCode.streaming'] === false && contextKeys['piCode.alive'] === false, 'a stopped task clears the streaming and alive keys');
ok(contextKeys['piCode.hasTask'] === true, 'a stopped task is still a task');

// --- session timeline rows (shapes taken from a live pi 0.85.1 session) ---
const row = (entry, here = false, branches = false) => timelineRow(entry, 0, here, branches);
const modelRow = row({ type: 'model_change', id: 'a', timestamp: '2026-09-08T09:17:33.780Z', provider: 'litellm', modelId: 'gpt-6-astra-max' });
ok(modelRow.label.includes('gpt-6-astra-max') && modelRow.detail === 'litellm', 'a model change is a timeline row');
ok(row({ type: 'thinking_level_change', id: 'b', timestamp: '2026-09-08T09:17:33.780Z', thinkingLevel: 'off' }).label.includes('thinking'), 'a thinking level change is a timeline row');
const userRow = row({ type: 'message', id: 'u1', timestamp: '2026-09-08T09:17:33.780Z', message: { role: 'user', content: [{ type: 'text', text: 'say  ok' }] } });
ok(userRow.fork && userRow.fork.entryId === 'u1' && userRow.fork.text === 'say  ok', 'a prompt carries its own rewind point');
ok(userRow.label.includes('say ok'), 'whitespace in the label is collapsed');
ok(!row({ type: 'message', id: 'a1', timestamp: '2026-09-08T09:17:33.780Z', message: { role: 'assistant', content: 'done' } }).fork, 'an answer is shown but is not a rewind point');
ok(row({ type: 'message', id: 't1', timestamp: '2026-09-08T09:17:33.780Z', message: { role: 'tool', content: 'x' } }) === undefined, 'tool traffic stays out of the timeline');
const comp = row({ type: 'compaction', id: 'c1', timestamp: '2026-09-08T09:17:33.780Z', summary: 'we did things', tokensBefore: 10 });
ok(comp.label.includes('compacted') && comp.detail === 'we did things', 'a compaction is a timeline row with its summary');

(async () => {
// --- copying the last answer ---
task.conv.system = () => {};
task.conv.messages = [
  { role: 'assistant', text: 'first answer' },
  { role: 'tool', toolName: 'bash', output: 'x' },
  { role: 'assistant', text: 'final answer' },
];
await provider.copyLastAnswer();
ok(clipboard.text === 'final answer', 'the newest assistant answer lands on the clipboard');

// --- picking a crashed pi back up ---
const spawned = [];
provider.restartDelayMs = 1;
provider.spawn = async (t) => { spawned.push(t.id); t.alive = true; };
const dead = {};
task.proc = dead;
await provider.autoRestart(task, dead, 0);
ok(spawned.length === 0, 'a clean exit is not restarted');
task.proc = dead;
await provider.autoRestart(task, dead, 1);
ok(spawned.length === 1, 'a crash brings pi back');
for (let i = 0; i < 4; i++) { task.proc = dead; await provider.autoRestart(task, dead, 1); }
ok(spawned.length === 3, 'the third crash in a row is the last one picked up');
provider.restarts.delete('t1');
task.proc = dead;
config.autoRestart = false;
await provider.autoRestart(task, dead, 1);
ok(spawned.length === 3, 'auto-restart can be turned off');
config.autoRestart = true;
task.proc = undefined;

console.log(failed ? `\nFAILED (${failed})` : '\ncontext check passed');
process.exit(failed ? 1 : 0);
})();
