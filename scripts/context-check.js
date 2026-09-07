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
const vscodeStub = {
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  window: {
    get activeTextEditor() { return editor; },
    createStatusBarItem: () => ({ show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
  },
  languages: { getDiagnostics: () => diagnostics },
  workspace: { getConfiguration: () => ({ get: (k, d) => (config[k] !== undefined ? config[k] : d) }), workspaceFolders: [] },
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

const { PiCodeProvider } = require('../dist/extension');
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

console.log(failed ? `\nFAILED (${failed})` : '\ncontext check passed');
process.exit(failed ? 1 : 0);
