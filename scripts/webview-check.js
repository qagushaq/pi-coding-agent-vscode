#!/usr/bin/env node
/*
 * Runs the sidebar script inside a tiny DOM stub so syntax errors, render crashes and the markdown renderer
 * are caught without opening VS Code. Run after `npm run compile`.
 */
const { renderWebviewHtml } = require('../dist/webview');

const html = renderWebviewHtml('vscode-resource:', 'testnonce');
const script = /<script nonce="testnonce">([\s\S]*?)<\/script>/.exec(html)[1];

const posted = [];
const listeners = {};
function el(id) {
  const node = {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    disabled: false,
    dataset: {},
    selectionStart: 0,
    selectionEnd: 0,
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(name, fn) {
      (listeners[`${id}:${name}`] = listeners[`${id}:${name}`] || []).push(fn);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    focus() {},
    parentElement: null,
  };
  return node;
}
const nodes = {};
global.document = {
  getElementById: id => (nodes[id] = nodes[id] || el(id)),
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener(name, fn) {
    (listeners[`document:${name}`] = listeners[`document:${name}`] || []).push(fn);
  },
};
global.window = { addEventListener(name, fn) { (listeners[`window:${name}`] = listeners[`window:${name}`] || []).push(fn); } };
global.acquireVsCodeApi = () => ({ postMessage: m => posted.push(m) });
global.FileReader = class {};

new Function(script)();
console.log('ok - webview script evaluates');
if (!posted.some(m => m.type === 'ready')) throw new Error('webview did not post ready');

const dispatch = m => listeners['window:message'].forEach(fn => fn({ data: m }));
const md = '# Title\n\nSome **bold** and `code` and a [link](https://x.y).\n\n- one\n- two\n\n1. first\n2. second\n\n```ruby\nputs "hi" <b>\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote';
dispatch({
  type: 'state',
  activeTaskId: 't1',
  settings: { sendOnEnter: true, showThinking: true },
  tasks: [
    {
      id: 't1',
      name: 'Task 1',
      cwd: '/repo',
      alive: true,
      streaming: true,
      model: 'litellm/gpt-6-astra-xhigh-fast',
      tier: { family: 'gpt-6-astra', effort: 'xhigh', fast: true },
      thinking: 'off',
      sessionId: 'abcdef123',
      stats: { tokens: { input: 12000, output: 800 }, cost: 0.123, contextUsage: { percent: 12 } },
      widgets: { w: ['line 1', 'line 2'] },
      queue: { steering: ['do x'], followUp: [] },
      changedFiles: ['/repo/app/models/user.rb'],
      messages: [
        { id: 'u1', role: 'user', text: 'hello <script>', images: [{ mimeType: 'image/png', data: 'AAAA' }] },
        { id: 'a1', role: 'assistant', text: md, thinking: 'hmm', status: 'streaming' },
        { id: 't1', role: 'tool', toolName: 'edit', args: { path: '/repo/app/models/user.rb', oldText: 'a\nb', newText: 'a\nc' }, output: 'ok', status: 'done', path: '/repo/app/models/user.rb' },
        { id: 't2', role: 'tool', toolName: 'bash', args: { command: 'ls -la' }, output: 'total 0', status: 'running' },
        { id: 't3', role: 'tool', toolName: 'read', args: undefined, argsText: '{"path": "x', output: '', status: 'running' },
        { id: 'b1', role: 'bash', command: 'git status', output: 'clean', exitCode: 0, status: 'done' },
        { id: 'e1', role: 'error', text: 'boom' },
        { id: 'a2', role: 'assistant', text: '', thinking: '', status: 'error', error: '401 blocked' },
      ],
    },
  ],
});
dispatch({
  type: 'modelOptions',
  taskId: 't1',
  families: [
    { family: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], hasFast: true, hasBase: true },
    { family: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high'], hasFast: true, hasBase: true },
  ],
  levels: ['off'],
});
const out = nodes.messages.innerHTML;
const expect = (cond, msg) => {
  if (!cond) {
    console.error(out);
    throw new Error(`FAIL: ${msg}`);
  }
  console.log(`ok - ${msg}`);
};
expect(out.includes('hello &lt;script&gt;'), 'user text is escaped');
expect(out.includes('<h1>Title</h1>'), 'markdown heading');
expect(out.includes('<strong>bold</strong>') && out.includes('<code>code</code>'), 'inline bold and code');
expect(out.includes('<ul><li>one</li><li>two</li></ul>'), 'bullet list');
expect(out.includes('<ol><li>first</li><li>second</li></ol>'), 'ordered list');
expect(out.includes('class="lang-ruby">puts &quot;hi&quot; &lt;b&gt;</code>'), 'fenced code escaped with language');
expect(out.includes('<table>') && out.includes('<td>2</td>'), 'table');
expect(out.includes('<blockquote>quote</blockquote>'), 'blockquote');
expect(out.includes('<a href="https://x.y">link</a>'), 'link');
expect(out.includes('class="d">- b</span>') && out.includes('class="a">+ c</span>'), 'edit tool renders as diff');
expect(out.includes('app/models/user.rb') && !out.includes('/repo/app/models/user.rb</span>'), 'paths shortened relative to cwd');
expect(out.includes('exit 0'), 'direct bash block');
expect(out.includes('401 blocked'), 'assistant error box');
expect(out.includes('Thinking'), 'thinking block');
expect(nodes.footer.innerHTML.includes('ctx 12%') && nodes.footer.innerHTML.includes('$0.123'), 'footer stats');
expect(nodes.footer.innerHTML.includes('xhigh fast'), 'footer shows effort and speed');
expect(nodes.family.innerHTML.includes('GPT-6 Astra') && nodes.family.innerHTML.includes('selected'), 'family selector populated with current selected');
expect(nodes.effort.innerHTML.includes('>xhigh<') && nodes.effort.innerHTML.includes('>max<'), 'effort ladder from the current family');
expect(nodes.effort.disabled === false, 'effort selector enabled');
expect(nodes.fast.className === 'primary', 'fast toggle reflects state');
expect(nodes.thinking.style.display === 'none', 'thinking selector hidden when the provider has no levels');
expect(nodes.queue.innerHTML.includes('steer: do x'), 'queue shown');
expect(nodes.send.style.display === 'none' && nodes.stop.style.display === '', 'composer switches to steer/stop while streaming');
console.log('webview check passed');
