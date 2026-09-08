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
    classList: classList(),
    addEventListener(name, fn) {
      (listeners[`${id}:${name}`] = listeners[`${id}:${name}`] || []).push(fn);
    },
    childNodes: [],
    hidden: false,
    select() {},
    querySelectorAll(sel) {
      const want = sel.replace('mark.', '');
      return descendants(node).filter(n => n.nodeName === 'MARK' && (n.className === want || (n.classList && n.classList.has(want))));
    },
    querySelector: () => null,
    focus() {},
    parentElement: null,
  };
  return node;
}
const nodes = {};

/* A DOM tree just deep enough for the find-in-conversation code: text nodes, marks, fragments. */
function textNode(value) { return { nodeName: '#text', nodeValue: value, parentNode: null }; }
function classList() {
  const set = new Set();
  return { add: c => set.add(c), remove: c => set.delete(c), toggle: c => (set.has(c) ? set.delete(c) : set.add(c)), contains: c => set.has(c), has: c => set.has(c) };
}
function element(tag) {
  const node = { nodeName: tag.toUpperCase(), childNodes: [], className: '', parentNode: null, scrollIntoView() {} };
  node.classList = classList();
  node.appendChild = child => { child.parentNode = node; node.childNodes.push(child); return child; };
  node.replaceChild = (fresh, old) => {
    const i = node.childNodes.indexOf(old);
    const list = fresh.nodeName === '#fragment' ? fresh.childNodes : [fresh];
    list.forEach(n => { n.parentNode = node; });
    node.childNodes.splice(i, 1, ...list);
  };
  node.normalize = () => {};
  Object.defineProperty(node, 'textContent', {
    get() { return node.childNodes.map(c => (c.nodeName === '#text' ? c.nodeValue : c.textContent)).join(''); },
    set(v) { node.childNodes = [textNode(v)]; node.childNodes[0].parentNode = node; },
  });
  return node;
}
function descendants(root) {
  const out = [];
  (function walk(n) { (n.childNodes || []).forEach(c => { out.push(c); walk(c); }); })(root);
  return out;
}
global.NodeFilter = { SHOW_TEXT: 4 };
global.document = {
  getElementById: id => (nodes[id] = nodes[id] || el(id)),
  querySelectorAll: () => [],
  querySelector: () => null,
  createTextNode: textNode,
  createElement: element,
  createDocumentFragment: () => {
    const frag = element('#fragment');
    frag.nodeName = '#fragment';
    return frag;
  },
  createTreeWalker(root) {
    const list = descendants(root).filter(n => n.nodeName === '#text');
    let i = -1;
    return { nextNode: () => (++i < list.length ? list[i] : null) };
  },
  addEventListener(name, fn) {
    (listeners[`document:${name}`] = listeners[`document:${name}`] || []).push(fn);
  },
};
global.window = {
  getSelection: () => '',
  addEventListener(name, fn) { (listeners[`window:${name}`] = listeners[`window:${name}`] || []).push(fn); },
};
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
expect(/class="ctxbar "?><i style="width:12%"/.test(nodes.footer.innerHTML), 'context usage also drawn as a meter');
expect(nodes.footer.innerHTML.includes('xhigh fast'), 'footer shows effort and speed');
expect(nodes.family.innerHTML.includes('GPT-6 Astra') && nodes.family.innerHTML.includes('selected'), 'family selector populated with current selected');
expect(nodes.effort.innerHTML.includes('>xhigh<') && nodes.effort.innerHTML.includes('>max<'), 'effort ladder from the current family');
expect(nodes.effort.disabled === false, 'effort selector enabled');
expect(nodes.fast.className === 'primary', 'fast toggle reflects state');
expect(nodes.thinking.style.display === 'none', 'thinking selector hidden when the provider has no levels');
expect(nodes.queue.innerHTML.includes('steer: do x'), 'queue shown');
expect(nodes.send.style.display === 'none' && nodes.stop.style.display === '', 'composer switches to steer/stop while streaming');
expect(!out.includes('data-rewind'), 'no rewind buttons while the agent streams');

// Same task, idle: user messages must offer a rewind point numbered by user-message order.
dispatch({
  type: 'state',
  activeTaskId: 't1',
  settings: { sendOnEnter: true, showThinking: true },
  tasks: [
    {
      id: 't1', name: 'Task 1', cwd: '/repo', alive: true, streaming: false,
      model: 'litellm/gpt-6-astra-max', tier: { family: 'gpt-6-astra', effort: 'max', fast: false },
      thinking: 'off', sessionId: 'abcdef123', widgets: {}, queue: { steering: [], followUp: [] }, changedFiles: [],
      messages: [
        { id: 'u1', role: 'user', text: 'first' },
        { id: 'a1', role: 'assistant', text: 'ok', thinking: '', status: 'done' },
        { id: 'u2', role: 'user', text: 'second' },
        { id: 'a2', role: 'assistant', text: 'ok', thinking: '', status: 'done' },
      ],
    },
  ],
});
const idle = nodes.messages.innerHTML;
const expectIdle = (cond, msg) => { if (!cond) { console.error(idle); throw new Error(`FAIL: ${msg}`); } console.log(`ok - ${msg}`); };
expectIdle(idle.includes('data-rewind="0"') && idle.includes('data-rewind="1"'), 'rewind buttons numbered per user message');
expectIdle((idle.match(/data-rewind=/g) || []).length === 2, 'only user messages get a rewind button');

// --- prompt history and per-task drafts ---
const fire = (key, name, extra) => {
  const ev = Object.assign({ key, shiftKey: false, altKey: false, preventDefault() {}, target: nodes[key] }, extra || {});
  (listeners[name] || []).forEach(fn => fn(ev));
  return ev;
};
const input = nodes.input;
input.value = 'first prompt';
nodes.send.onclick();
expectIdle(input.value === '' && posted.some(m => m.type === 'send' && m.text === 'first prompt'), 'sending clears the box and posts the prompt');
input.value = 'second prompt';
nodes.send.onclick();

input.selectionStart = input.selectionEnd = 0;
fire('ArrowUp', 'input:keydown');
expectIdle(input.value === 'second prompt', 'Up recalls the last prompt');
fire('ArrowUp', 'input:keydown');
expectIdle(input.value === 'first prompt', 'Up again walks further back');
input.selectionStart = input.selectionEnd = input.value.length;
fire('ArrowDown', 'input:keydown');
expectIdle(input.value === 'second prompt', 'Down walks forward again');
fire('ArrowDown', 'input:keydown');
expectIdle(input.value === '', 'Down past the newest restores what was being typed');

const twoTasks = (activeTaskId) => ({
  type: 'state', activeTaskId, settings: { sendOnEnter: true, showThinking: true },
  tasks: ['t1', 't2'].map(id => ({ id, name: id, cwd: '/repo', alive: true, streaming: false, model: 'litellm/gpt-6-astra-max', tier: { family: 'gpt-6-astra', effort: 'max' }, thinking: 'off', widgets: {}, queue: { steering: [], followUp: [] }, changedFiles: [], messages: [] })),
});
input.value = 'draft for one';
(listeners['input:input'] || []).forEach(fn => fn({}));
dispatch(twoTasks('t2'));
expectIdle(input.value === '', 'switching tasks parks the draft and shows an empty box');
input.value = 'draft for two';
(listeners['input:input'] || []).forEach(fn => fn({}));
dispatch(twoTasks('t1'));
expectIdle(input.value === 'draft for one', 'switching back brings the draft with it');
dispatch(twoTasks('t2'));
expectIdle(input.value === 'draft for two', 'each task keeps its own draft');
input.value = '';
(listeners['input:input'] || []).forEach(fn => fn({}));

// --- jump to latest, copy answer, context meter ---
expectIdle(idle.includes('data-copymsg="a1"'), 'a finished answer offers a copy button');
expectIdle(!out.includes('data-copymsg="a1"'), 'an answer still streaming does not');
expectIdle(nodes.jump.hidden === true, 'the jump button stays hidden while the log fits');
nodes.messages.scrollHeight = 1000; nodes.messages.scrollTop = 0; nodes.messages.clientHeight = 100;
(listeners['messages:scroll'] || []).forEach(fn => fn({}));
expectIdle(nodes.jump.hidden === false, 'scrolling away from the end shows the jump button');
expectIdle(nodes.jump.classList.contains('unread') === false, 'an idle task does not nag with it');
nodes.jump.onclick();
expectIdle(nodes.messages.scrollTop === 1000, 'the jump button scrolls to the latest message');
nodes.messages.scrollHeight = 100; nodes.messages.scrollTop = 0;

const menuHtml = html;
['timeline', 'branch', 'copyLast', 'modes', 'terminal', 'logs', 'find'].forEach(act => {
  expectIdle(menuHtml.includes(`data-act="${act}"`), `the menu offers ${act}`);
});

// --- find in conversation ---
const para = document.createElement('div');
para.appendChild(document.createTextNode('alpha beta alpha'));
const inner = document.createElement('span');
inner.appendChild(document.createTextNode('and ALPHA again'));
para.appendChild(inner);
nodes.messages.childNodes = [para];
para.parentNode = nodes.messages;

fire('f', 'document:keydown', { metaKey: true });
expectIdle(nodes.find.hidden === false, 'Ctrl/Cmd+F opens the find bar');
nodes.findInput.value = 'alpha';
(listeners['findInput:input'] || []).forEach(fn => fn({}));
expectIdle(nodes.findCount.textContent === '1 of 3', `every match is counted case-insensitively: ${nodes.findCount.textContent}`);
expectIdle(nodes.messages.querySelectorAll('mark.hit').length === 3, 'matches are wrapped in marks');
fire('Enter', 'findInput:keydown');
expectIdle(nodes.findCount.textContent === '2 of 3', 'Enter steps to the next match');
nodes.findInput.value = 'nothing here';
(listeners['findInput:input'] || []).forEach(fn => fn({}));
expectIdle(nodes.findCount.textContent === 'no matches', 'a miss says so');
expectIdle(nodes.messages.querySelectorAll('mark.hit').length === 0, 'marks are cleaned up between searches');
fire('Escape', 'findInput:keydown');
expectIdle(nodes.find.hidden === true, 'Escape closes the find bar');

console.log('webview check passed');
