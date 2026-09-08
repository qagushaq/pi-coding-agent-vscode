/**
 * Sidebar HTML. Kept as one self-contained document: CSS + a small vanilla JS app with its own markdown renderer.
 * Inside the script we avoid template literals so this TS template string stays simple to reason about.
 */
export function renderWebviewHtml(cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data: https:; font-src ${cspSource};">
<style>
  :root{
    --bg:var(--vscode-sideBar-background,var(--vscode-editor-background));--fg:var(--vscode-foreground);--muted:var(--vscode-descriptionForeground);
    --border:var(--vscode-panel-border,rgba(128,128,128,.25));--accent:var(--vscode-button-background);--accentFg:var(--vscode-button-foreground);
    --input:var(--vscode-input-background);--inputFg:var(--vscode-input-foreground);--card:var(--vscode-editorWidget-background,var(--vscode-editor-background));
    --code:var(--vscode-textCodeBlock-background,rgba(128,128,128,.12));--link:var(--vscode-textLink-foreground);--err:var(--vscode-errorForeground);
    --warn:var(--vscode-editorWarning-foreground,#d9a33a);--ok:var(--vscode-testing-iconPassed,#6cbf6c);--mono:var(--vscode-editor-font-family,monospace);
    --add:var(--vscode-diffEditor-insertedTextBackground,rgba(80,200,120,.2));--del:var(--vscode-diffEditor-removedTextBackground,rgba(255,90,90,.2));
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);display:flex;flex-direction:column;overflow:hidden}
  button{background:transparent;color:var(--fg);border:1px solid var(--border);padding:4px 9px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;line-height:1.3;white-space:nowrap}
  button:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.15))}
  button.primary{background:var(--accent);color:var(--accentFg);border-color:transparent}
  button.primary:hover{filter:brightness(1.1)}
  button.danger{color:var(--err);border-color:var(--err)}
  button:disabled{opacity:.5;cursor:default}
  select{background:var(--vscode-dropdown-background,var(--input));color:var(--vscode-dropdown-foreground,var(--fg));border:1px solid var(--vscode-dropdown-border,var(--border));padding:3px 6px;border-radius:4px;font-size:12px;max-width:100%;min-width:0}
  a{color:var(--link);cursor:pointer;text-decoration:none}a:hover{text-decoration:underline}

  .tabs{display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid var(--border);padding:4px 6px 0;flex:none;scrollbar-width:thin}
  .tab{padding:5px 8px;border:1px solid transparent;border-bottom:0;border-radius:5px 5px 0 0;cursor:pointer;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis;color:var(--muted);display:flex;align-items:center;gap:6px;font-size:12px}
  .tab.active{color:var(--fg);border-color:var(--border);background:var(--card)}
  .tab .x{opacity:.5;padding:0 2px}.tab .x:hover{opacity:1;color:var(--err)}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}.dot.running{background:var(--ok);animation:pulse 1.2s infinite}.dot.error{background:var(--err)}.dot.dead{background:var(--warn)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}

  .toolbar{display:flex;gap:6px;padding:6px;border-bottom:1px solid var(--border);align-items:center;flex-wrap:wrap;flex:none}
  .toolbar select{flex:1 1 120px}
  .menu{position:relative}
  .menu-list{position:absolute;right:0;top:100%;z-index:30;background:var(--card);border:1px solid var(--border);border-radius:5px;box-shadow:0 6px 20px rgba(0,0,0,.3);display:none;flex-direction:column;min-width:200px;padding:4px}
  .menu-list.open{display:flex}
  .menu-list button{border:0;text-align:left;border-radius:3px;padding:6px 10px}

  .changed{border-bottom:1px solid var(--border);padding:4px 8px;font-size:12px;flex:none;max-height:120px;overflow:auto}
  .changed summary{cursor:pointer;color:var(--muted)}
  .changed .file{display:flex;gap:8px;align-items:center;padding:2px 0 2px 12px;font-family:var(--mono);font-size:11px}
  .changed .file span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .messages{flex:1;overflow-y:auto;overflow-x:hidden;padding:10px 8px;display:flex;flex-direction:column;gap:10px;scroll-behavior:auto}
  .msg{max-width:100%;border-radius:8px;line-height:1.5;word-wrap:break-word;overflow-wrap:anywhere;min-width:0}
  .msg.user{align-self:flex-end;background:var(--vscode-input-background);border:1px solid var(--border);padding:8px 11px;max-width:92%;white-space:pre-wrap}
  .msg.user .imgs{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.msg.user .imgs img{max-width:120px;max-height:90px;border-radius:5px;border:1px solid var(--border)}
  .msg.user{position:relative}
  .msg.user .rew{position:absolute;top:2px;right:100%;margin-right:6px;opacity:0;transition:opacity .12s;background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:2px 4px;border-radius:4px;line-height:1}
  .msg.user:hover .rew{opacity:1}
  .msg.user .rew:hover{background:var(--vscode-toolbar-hoverBackground,var(--border));color:var(--fg)}
  .msg.assistant{align-self:stretch;padding:2px 4px}
  .msg.assistant.error .md{opacity:.8}
  .msg .errbox{border:1px solid var(--err);color:var(--err);border-radius:6px;padding:6px 9px;margin-top:6px;font-family:var(--mono);font-size:11px;white-space:pre-wrap}
  .msg.system,.msg.warning,.msg.error,.msg.compaction{align-self:center;color:var(--muted);font-size:11px;text-align:center;padding:2px 8px;white-space:pre-wrap;max-width:100%}
  .msg.error{color:var(--err)}.msg.warning{color:var(--warn)}
  .cursor::after{content:'▍';animation:pulse 1s infinite;color:var(--muted)}

  .md p{margin:0 0 8px}.md p:last-child{margin-bottom:0}.md h1,.md h2,.md h3,.md h4{margin:10px 0 6px;font-size:1.05em}.md h1{font-size:1.2em}.md h2{font-size:1.12em}
  .md ul,.md ol{margin:0 0 8px;padding-left:22px}.md li{margin:2px 0}.md blockquote{margin:0 0 8px;padding:2px 10px;border-left:3px solid var(--border);color:var(--muted)}
  .md code{font-family:var(--mono);font-size:.92em;background:var(--code);padding:1px 4px;border-radius:3px}
  .md pre{margin:0 0 8px;background:var(--code);border:1px solid var(--border);border-radius:6px;padding:8px 10px;overflow:auto;position:relative}
  .md pre code{background:transparent;padding:0;font-size:11.5px;white-space:pre}
  .md pre .copy{position:absolute;top:4px;right:4px;font-size:10px;padding:2px 6px;opacity:0}.md pre:hover .copy{opacity:1}
  .md table{border-collapse:collapse;margin:0 0 8px;font-size:12px}.md th,.md td{border:1px solid var(--border);padding:3px 7px}
  .md hr{border:0;border-top:1px solid var(--border);margin:8px 0}

  details.think{margin:2px 0 6px;font-size:12px;color:var(--muted)}details.think summary{cursor:pointer;user-select:none}details.think .body{white-space:pre-wrap;padding:4px 8px;border-left:2px solid var(--border);margin-top:4px;max-height:280px;overflow:auto;font-style:italic}

  .tool{align-self:stretch;border:1px solid var(--border);border-radius:6px;background:var(--card);font-size:12px;overflow:hidden}
  .tool .head{display:flex;align-items:center;gap:7px;padding:5px 8px;cursor:pointer;user-select:none;min-width:0}
  .tool .head .name{font-weight:600;flex:none}.tool .head .sum{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:11px;color:var(--muted)}
  .tool .head .act{flex:none;font-size:11px}
  .tool .body{border-top:1px solid var(--border);padding:6px 8px;display:none}.tool.open .body{display:block}
  .tool pre{margin:0;font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
  .tool .lbl{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin:6px 0 2px}.tool .lbl:first-child{margin-top:0}
  .diff{font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
  .diff .d{background:var(--del);display:block}.diff .a{background:var(--add);display:block}
  .tool.error .head .name{color:var(--err)}

  .queue{padding:4px 8px;border-top:1px solid var(--border);font-size:11px;color:var(--muted);flex:none}
  .widget{padding:4px 8px;border-top:1px solid var(--border);font-family:var(--mono);font-size:11px;white-space:pre-wrap;color:var(--muted);flex:none}

  .composer{border-top:1px solid var(--border);padding:8px;display:flex;flex-direction:column;gap:6px;flex:none;position:relative}
  .chips{display:flex;gap:6px;flex-wrap:wrap}.chips:empty{display:none}
  .chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border);border-radius:12px;padding:2px 8px;font-size:11px;font-family:var(--mono);max-width:100%;background:var(--card)}
  .chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chip b{font-weight:normal;color:var(--muted)}.chip .rm{cursor:pointer;opacity:.6}.chip .rm:hover{opacity:1;color:var(--err)}
  .chip img{height:26px;border-radius:3px}
  textarea{width:100%;min-height:58px;max-height:240px;resize:none;background:var(--input);color:var(--inputFg);border:1px solid var(--vscode-input-border,var(--border));border-radius:6px;padding:8px 10px;font-family:var(--vscode-font-family);font-size:13px;outline:none;line-height:1.4}
  textarea:focus{border-color:var(--vscode-focusBorder)}
  .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.grow{flex:1}.hint{font-size:11px;color:var(--muted)}
  .popup{position:absolute;left:8px;right:8px;bottom:100%;background:var(--card);border:1px solid var(--border);border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.3);max-height:220px;overflow:auto;z-index:20;display:none}
  .popup.open{display:block}.popup div{padding:5px 10px;cursor:pointer;font-size:12px;display:flex;gap:8px}.popup div.sel,.popup div:hover{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
  .popup small{color:inherit;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .footer{display:flex;gap:10px;padding:3px 8px 5px;font-size:11px;color:var(--muted);flex-wrap:wrap;flex:none;border-top:1px solid var(--border)}
  .footer span{white-space:nowrap}
  .find{display:flex;gap:4px;align-items:center;padding:4px 6px;border-bottom:1px solid var(--border);flex:none}
  .find input{flex:1;min-width:0;background:var(--vscode-input-background);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:12px}
  .find span{font-size:11px;color:var(--muted);white-space:nowrap}
  .find button{padding:1px 6px}
  mark.hit{background:var(--vscode-editor-findMatchHighlightBackground,rgba(255,220,0,.35));color:inherit;border-radius:2px}
  mark.hit.current{background:var(--vscode-editor-findMatchBackground,rgba(255,150,50,.6))}
  button:focus-visible,select:focus-visible,textarea:focus-visible,input:focus-visible,.tab:focus-visible,[tabindex]:focus-visible{outline:1px solid var(--vscode-focusBorder,#3794ff);outline-offset:1px}
  .empty{color:var(--muted);text-align:center;margin:auto;padding:30px 16px;font-size:12px;line-height:1.7}
  .empty kbd{font-family:var(--mono);background:var(--code);padding:0 4px;border-radius:3px}
</style></head>
<body>
  <div class="tabs" id="tabs"></div>
  <div class="toolbar">
    <select id="family" title="Model family"><option value="">Model…</option></select>
    <select id="effort" title="Reasoning effort"><option value="">Effort</option></select>
    <button id="fast" title="Prefer the -fast variant of this model">fast</button>
    <select id="thinking" title="Thinking level" style="display:none"></select>
    <div class="menu"><button id="menuBtn" title="More">⋯</button>
      <div class="menu-list" id="menu">
        <button data-act="newTask">New task</button>
        <button data-act="resume">Resume session…</button>
        <button data-act="newSession">New session (clear history)</button>
        <button data-act="rename">Rename task</button>
        <button data-act="compact">Compact context</button>
        <button data-act="exportHtml">Export session to HTML</button>
        <button data-act="copySessionPath">Copy session path</button>
        <button data-act="restart">Restart pi process</button>
        <button data-act="closeTask">Close task</button>
      </div>
    </div>
  </div>
  <details class="changed" id="changed" style="display:none"><summary id="changedSummary"></summary><div id="changedList"></div></details>
  <div class="find" id="find" hidden>
    <input id="findInput" type="search" placeholder="Find in conversation" aria-label="Find in conversation">
    <span id="findCount" aria-live="polite"></span>
    <button id="findPrev" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
    <button id="findNext" title="Next match (Enter)" aria-label="Next match">↓</button>
    <button id="findClose" title="Close (Escape)" aria-label="Close find">×</button>
  </div>
  <div class="messages" id="messages" role="log" aria-label="Conversation" aria-live="polite"></div>
  <div class="widget" id="widget" style="display:none"></div>
  <div class="queue" id="queue" style="display:none"></div>
  <div class="composer">
    <div class="popup" id="popup"></div>
    <div class="chips" id="chips"></div>
    <textarea id="input" placeholder="Ask pi… (@ file, / command, ! shell)"></textarea>
    <div class="row">
      <button class="primary" id="send">Send</button>
      <button id="steer" style="display:none" title="Deliver after the current tool calls finish">Steer</button>
      <button id="queueBtn" style="display:none" title="Deliver when the agent finishes">Queue</button>
      <button class="danger" id="stop" style="display:none">Stop</button>
      <span class="grow"></span>
      <button id="attach" title="Attach image">Image</button>
      <button id="addSel" title="Add editor selection (Cmd/Ctrl+Alt+L)">Selection</button>
      <button id="atFile" title="Mention a workspace file">@</button>
    </div>
  </div>
  <div class="footer" id="footer"></div>
<script nonce="${nonce}">
(function(){
var vscode=acquireVsCodeApi();
var state={tasks:[],activeTaskId:null,settings:{sendOnEnter:true,showThinking:true}};
var perTask={}; // taskId -> {models,levels,commands}
var chips=[]; var popupItems=[]; var popupIndex=0; var popupMode=null; var openTools={}; var wasAtBottom=true;
var drafts={};      // taskId -> unsent text, so switching tabs never eats what you typed
var history={};     // taskId -> prompts sent, newest last
var histIndex=null; // where Up/Down currently sits in that list
var histStash='';   // what was in the box before walking back through history
var $=function(id){return document.getElementById(id)};
var messagesEl=$('messages'), inputEl=$('input');

vscode.postMessage({type:'ready'});
window.addEventListener('message',function(e){var m=e.data;
  if(m.type==='state'){swapDraft(m.activeTaskId);state=m;render();}
  else if(m.type==='modelOptions'){perTask[m.taskId]=Object.assign(perTask[m.taskId]||{},{families:m.families||[],levels:m.levels||[]});renderSelectors();}
  else if(m.type==='commands'){perTask[m.taskId]=perTask[m.taskId]||{};perTask[m.taskId].commands=m.commands||[];}
  else if(m.type==='addContext'){addChip(m.chip);}
  else if(m.type==='insertMention'){insertAtCursor('@'+m.path+' ');}
  else if(m.type==='attachedImages'){(m.images||[]).forEach(function(i){addChip({kind:'image',label:i.fileName||i.mimeType,mimeType:i.mimeType,data:i.data});});}
  else if(m.type==='setEditorText'){inputEl.value=m.text||'';autosize();inputEl.focus();}
  else if(m.type==='restoreQueued'){if(m.texts&&m.texts.length){inputEl.value=(inputEl.value?inputEl.value+'\\n':'')+m.texts.join('\\n');autosize();}}
  else if(m.type==='focusInput'){inputEl.focus();}
});

function active(){for(var i=0;i<state.tasks.length;i++)if(state.tasks[i].id===state.activeTaskId)return state.tasks[i];return null;}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function escAttr(s){return esc(s);} // esc already escapes quotes; kept as a separate name for attribute call sites
function short(p){if(!p)return '';var t=active();if(t&&t.cwd&&p.indexOf(t.cwd)===0)p=p.slice(t.cwd.length).replace(/^[\\/\\\\]/,'');return p;}

function render(){renderTabs();renderChanged();renderMessages();renderSelectors();renderComposer();renderFooter();renderQueue();renderWidget();}

function renderTabs(){var html='';state.tasks.forEach(function(t){var st=!t.alive?'dead':(t.streaming?'running':(t.lastError?'error':'idle'));html+='<div class="tab'+(t.id===state.activeTaskId?' active':'')+'" data-id="'+esc(t.id)+'" title="'+esc(t.sessionFile||'')+'"><span class="dot '+st+'"></span><span>'+esc(t.name)+'</span><span class="x" data-close="'+esc(t.id)+'" title="Close task">×</span></div>';});
  html+='<div class="tab" data-new="1" title="New task">＋</div>';$('tabs').innerHTML=html;
  [].forEach.call(document.querySelectorAll('.tab[data-id]'),function(n){n.onclick=function(ev){if(ev.target.dataset.close){vscode.postMessage({type:'closeTask',taskId:ev.target.dataset.close});return;}vscode.postMessage({type:'switchTask',taskId:n.dataset.id});};});
  var nt=document.querySelector('.tab[data-new]');if(nt)nt.onclick=function(){vscode.postMessage({type:'newTask'});};}

function renderChanged(){var t=active();var box=$('changed');if(!t||!t.changedFiles||!t.changedFiles.length){box.style.display='none';return;}box.style.display='';$('changedSummary').textContent='Changed files ('+t.changedFiles.length+')';
  $('changedList').innerHTML=t.changedFiles.map(function(f){return '<div class="file"><span title="'+esc(f)+'">'+esc(short(f))+'</span><a data-open="'+esc(f)+'">open</a><a data-diff="'+esc(f)+'">diff</a></div>';}).join('');
  [].forEach.call($('changedList').querySelectorAll('a[data-open]'),function(a){a.onclick=function(){vscode.postMessage({type:'openFile',path:a.dataset.open});};});
  [].forEach.call($('changedList').querySelectorAll('a[data-diff]'),function(a){a.onclick=function(){vscode.postMessage({type:'openDiff',path:a.dataset.diff});};});}

function renderMessages(){var t=active();var el=messagesEl;var atBottom=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  if(!t){el.innerHTML='<div class="empty">No task. Press ＋ to start one.</div>';return;}
  if(!t.messages.length){el.innerHTML='<div class="empty">Session '+esc((t.sessionId||'').slice(0,8))+' in <b>'+esc(short(t.cwd)||t.cwd)+'</b><br>Type a prompt. <kbd>@</kbd> mentions a file, <kbd>/</kbd> lists commands, <kbd>!cmd</kbd> runs a shell command into context.<br>'+(state.settings.sendOnEnter?'<kbd>Enter</kbd> sends, <kbd>Shift+Enter</kbd> newline.':'<kbd>Ctrl/Cmd+Enter</kbd> sends.')+'</div>';return;}
  var html='';var ui=0;t.messages.forEach(function(m){if(m.role==='user')m.userIndex=ui++;html+=renderMessage(m,t);});el.innerHTML=html;bindMessageHandlers();
  if(!$('find').hidden&&$('findInput').value){findHits=[];findAt=-1;runFind();}
  if(atBottom||wasAtBottom)el.scrollTop=el.scrollHeight;wasAtBottom=false;}

function renderMessage(m,t){
  if(m.role==='user'){var rw=(typeof m.userIndex==='number'&&!t.streaming)?'<button class="rew" data-rewind="'+m.userIndex+'" title="Rewind the conversation to just before this message">\u21b6</button>':'';
    return '<div class="msg user">'+rw+esc(m.text)+(m.images&&m.images.length?'<div class="imgs">'+m.images.map(function(i){return '<img src="data:'+esc(i.mimeType)+';base64,'+i.data+'">';}).join('')+'</div>':'')+'</div>';}
  if(m.role==='assistant'){var h='<div class="msg assistant'+(m.status==='error'?' error':'')+'">';
    if(m.thinking&&state.settings.showThinking){h+='<details class="think"'+(m.status==='streaming'&&!m.text?' open':'')+'><summary>Thinking'+(m.status==='streaming'&&!m.text?'…':'')+'</summary><div class="body">'+esc(m.thinking)+'</div></details>';}
    h+='<div class="md'+(m.status==='streaming'?' cursor':'')+'">'+md(m.text)+'</div>';
    if(m.status==='error'&&m.error)h+='<div class="errbox">'+esc(m.error)+'</div>';
    if(m.status==='aborted')h+='<div class="hint">aborted</div>';
    return h+'</div>';}
  if(m.role==='tool')return renderTool(m);
  if(m.role==='bash'){return '<div class="tool'+(m.status==='error'?' error':'')+(openTools[m.id]!==false?' open':'')+'" data-tool="'+esc(m.id)+'"><div class="head"><span class="dot '+(m.status==='running'?'running':m.status==='error'?'error':'')+'"></span><span class="name">$</span><span class="sum">'+esc(m.command)+'</span>'+(m.exitCode!=null?'<span class="act">exit '+m.exitCode+'</span>':'')+'</div><div class="body"><pre>'+esc(m.output||'')+'</pre></div></div>';}
  return '<div class="msg '+esc(m.role)+'">'+esc(m.text)+'</div>';}

function toolSummary(m){var a=m.args||{};if(m.toolName==='bash')return a.command||'';if(a.path||a.file_path)return short(a.path||a.file_path)+(a.offset?':'+a.offset:'');if(a.pattern)return a.pattern+(a.path?' in '+short(a.path):'');if(a.query)return a.query;if(m.argsText)return m.argsText.slice(0,120);var keys=Object.keys(a);return keys.length?keys.map(function(k){var v=a[k];return k+'='+(typeof v==='string'?v.slice(0,60):JSON.stringify(v));}).join(' ').slice(0,160):'';}
function renderTool(m){var open=openTools[m.id]!==undefined?openTools[m.id]:(m.status==='error'||m.status==='running');var a=m.args||{};var body='';
  if(m.toolName==='edit'&&(a.oldText!=null||a.newText!=null)){body+='<div class="lbl">Edit</div><div class="diff">'+String(a.oldText||'').split('\\n').map(function(l){return '<span class="d">- '+esc(l)+'</span>';}).join('')+String(a.newText||'').split('\\n').map(function(l){return '<span class="a">+ '+esc(l)+'</span>';}).join('')+'</div>';}
  else if(m.toolName==='write'&&a.content!=null){body+='<div class="lbl">Write '+esc(short(a.path))+'</div><pre>'+esc(String(a.content).slice(0,6000))+'</pre>';}
  else if(m.toolName==='bash'){}
  else if(m.args){body+='<div class="lbl">Arguments</div><pre>'+esc(JSON.stringify(a,null,2).slice(0,4000))+'</pre>';}
  else if(m.argsText){body+='<div class="lbl">Arguments</div><pre>'+esc(m.argsText.slice(0,4000))+'</pre>';}
  if(m.output)body+='<div class="lbl">'+(m.status==='error'?'Error':'Output')+'</div><pre>'+esc(m.output)+'</pre>';
  if(!body)body='<div class="hint">'+(m.status==='running'?'running…':'no output')+'</div>';
  var acts='';if(m.path){acts+='<a class="act" data-open="'+esc(m.path)+'">open</a>';if(m.toolName==='edit'||m.toolName==='write')acts+=' <a class="act" data-diff="'+esc(m.path)+'">diff</a>';}
  return '<div class="tool'+(m.status==='error'?' error':'')+(open?' open':'')+'" data-tool="'+esc(m.id)+'"><div class="head"><span class="dot '+(m.status==='running'?'running':m.status==='error'?'error':'')+'"></span><span class="name">'+esc(m.toolName)+'</span><span class="sum" title="'+esc(toolSummary(m))+'">'+esc(toolSummary(m))+'</span>'+acts+'</div><div class="body">'+body+'</div></div>';}

function bindMessageHandlers(){[].forEach.call(messagesEl.querySelectorAll('.tool .head'),function(h){h.onclick=function(ev){if(ev.target.dataset.open){vscode.postMessage({type:'openFile',path:ev.target.dataset.open});return;}if(ev.target.dataset.diff){vscode.postMessage({type:'openDiff',path:ev.target.dataset.diff});return;}var box=h.parentElement;box.classList.toggle('open');openTools[box.dataset.tool]=box.classList.contains('open');};});
  [].forEach.call(messagesEl.querySelectorAll('.md .copy'),function(b){b.onclick=function(){vscode.postMessage({type:'copyText',text:b.parentElement.querySelector('code').textContent});b.textContent='copied';setTimeout(function(){b.textContent='copy';},1200);};});
  [].forEach.call(messagesEl.querySelectorAll('.md a[href]'),function(a){a.onclick=function(ev){ev.preventDefault();vscode.postMessage({type:'openLink',href:a.getAttribute('href')});};});
  [].forEach.call(messagesEl.querySelectorAll('.msg.user .rew'),function(b){b.onclick=function(){vscode.postMessage({type:'rewind',index:Number(b.dataset.rewind)});};});}

function renderSelectors(){
  var t=active();var info=t?perTask[t.id]||{}:{};var fams=info.families||[];
  var cur=t&&t.tier?t.tier:{};
  var fs=$('family');
  fs.innerHTML=(fams.length?'':'<option value="">Model…</option>')+fams.map(function(f){
    return '<option value="'+escAttr(f.family)+'"'+(f.family===cur.family?' selected':'')+'>'+esc(f.label)+'</option>';}).join('');
  if(cur.family&&!fams.some(function(f){return f.family===cur.family;}))
    fs.innerHTML='<option value="'+escAttr(cur.family)+'" selected>'+esc(cur.family)+'</option>'+fs.innerHTML;
  var fam=fams.filter(function(f){return f.family===cur.family;})[0];
  var es=$('effort');var efforts=fam?fam.efforts:[];
  if(!efforts.length){es.innerHTML='<option value="">no effort levels</option>';es.disabled=true;}
  else{es.disabled=false;es.innerHTML=efforts.map(function(e){
    return '<option value="'+escAttr(e)+'"'+(e===cur.effort?' selected':'')+'>'+esc(e)+'</option>';}).join('');}
  var fb=$('fast');
  if(fam&&fam.hasFast){fb.style.display='';fb.className=cur.fast?'primary':'';fb.title=cur.fast?'Fast variant on':'Fast variant off';}
  else fb.style.display='none';
  var th=$('thinking');var levels=info.levels||[];
  if(levels.length>1){th.style.display='';th.innerHTML=levels.map(function(l){
    return '<option value="'+escAttr(l)+'"'+(l===(t&&t.thinking)?' selected':'')+'>think: '+esc(l)+'</option>';}).join('');}
  else th.style.display='none';
}
function renderComposer(){var t=active();var s=!!(t&&t.streaming);var alive=!!(t&&t.alive);$('send').style.display=s?'none':'';$('steer').style.display=s?'':'none';$('queueBtn').style.display=s?'':'none';$('stop').style.display=s?'':'none';$('send').disabled=!alive;$('send').textContent=alive?'Send':'pi not running';}
function renderFooter(){var t=active();var f=$('footer');if(!t){f.innerHTML='';return;}var parts=[];if(t.sessionName)parts.push('<span title="'+esc(t.sessionFile||'')+'">'+esc(t.sessionName)+'</span>');else if(t.sessionId)parts.push('<span title="'+esc(t.sessionFile||'')+'">session '+esc(t.sessionId.slice(0,8))+'</span>');
  if(t.model){var tier=t.tier||{};var lbl=esc(t.model.split('/').pop());
    if(tier.effort)lbl+=' · '+esc(tier.effort)+(tier.fast?' fast':'');
    else if(t.thinking&&t.thinking!=='off')lbl+=' · '+esc(t.thinking);
    parts.push('<span>'+lbl+'</span>');}
  var st=t.stats;if(st){if(st.contextUsage&&st.contextUsage.percent!=null)parts.push('<span title="context window">ctx '+Math.round(st.contextUsage.percent)+'%</span>');if(st.tokens)parts.push('<span title="input / output tokens">'+fmt(st.tokens.input)+' in · '+fmt(st.tokens.output)+' out</span>');if(st.cost!=null&&st.cost>0)parts.push('<span>$'+st.cost.toFixed(st.cost<1?3:2)+'</span>');}
  f.innerHTML=parts.join('<span>·</span>');}
function renderQueue(){var t=active();var q=t&&t.queue;var el=$('queue');var items=[];if(q){(q.steering||[]).forEach(function(x){items.push('steer: '+x);});(q.followUp||[]).forEach(function(x){items.push('queued: '+x);});}if(!items.length){el.style.display='none';return;}el.style.display='';el.innerHTML=items.map(function(x){return '<div>'+esc(x.slice(0,200))+'</div>';}).join('');}
function renderWidget(){var t=active();var el=$('widget');var lines=t&&t.widgets?Object.keys(t.widgets).map(function(k){return t.widgets[k].join('\\n');}):[];if(!lines.length){el.style.display='none';return;}el.style.display='';el.textContent=lines.join('\\n');}
function fmt(n){if(n==null)return '?';if(n>=1e6)return (n/1e6).toFixed(1)+'M';if(n>=1e3)return (n/1e3).toFixed(n>=1e4?0:1)+'K';return String(n);}

/* ---------- chips (context attachments) ---------- */
function addChip(c){chips.push(c);renderChips();inputEl.focus();}
function renderChips(){$('chips').innerHTML=chips.map(function(c,i){var body=c.kind==='image'?'<img src="data:'+esc(c.mimeType)+';base64,'+c.data+'"><span>'+esc(c.label)+'</span>':'<b>'+(c.kind==='selection'?'sel':'file')+'</b><span title="'+esc(c.path)+'">'+esc(c.label)+'</span>';return '<span class="chip">'+body+'<span class="rm" data-i="'+i+'">×</span></span>';}).join('');
  [].forEach.call($('chips').querySelectorAll('.rm'),function(n){n.onclick=function(){chips.splice(Number(n.dataset.i),1);renderChips();};});}

/* ---------- sending ---------- */
function send(mode){var text=inputEl.value.trim();if(!text&&!chips.length)return;var t=active();if(!t)return;
  var images=chips.filter(function(c){return c.kind==='image';}).map(function(c){return {type:'image',data:c.data,mimeType:c.mimeType};});
  var ctx=chips.filter(function(c){return c.kind!=='image';});
  vscode.postMessage({type:'send',mode:mode||'prompt',text:text||(images.length?'Please look at the attached image.':''),images:images,context:ctx});
  var list=history[t.id]||(history[t.id]=[]);
  if(text&&list[list.length-1]!==text)list.push(text);
  if(list.length>100)list.shift();
  histIndex=null;histStash='';
  delete drafts[t.id];
  inputEl.value='';chips=[];renderChips();autosize();closePopup();wasAtBottom=true;}
$('send').onclick=function(){send('prompt');};$('steer').onclick=function(){send('steer');};$('queueBtn').onclick=function(){send('followUp');};
$('stop').onclick=function(){vscode.postMessage({type:'stop'});};
$('attach').onclick=function(){vscode.postMessage({type:'attachImage'});};$('addSel').onclick=function(){vscode.postMessage({type:'addSelection'});};$('atFile').onclick=function(){vscode.postMessage({type:'pickFile'});};
$('family').onchange=function(e){if(e.target.value)vscode.postMessage({type:'setTier',family:e.target.value});};
$('effort').onchange=function(e){if(e.target.value)vscode.postMessage({type:'setTier',effort:e.target.value});};
$('fast').onclick=function(){var t=active();vscode.postMessage({type:'setTier',fast:!(t&&t.tier&&t.tier.fast)});};
$('thinking').onchange=function(e){if(e.target.value)vscode.postMessage({type:'setThinking',level:e.target.value});};
$('menuBtn').onclick=function(ev){ev.stopPropagation();$('menu').classList.toggle('open');};
document.addEventListener('click',function(){$('menu').classList.remove('open');});
[].forEach.call($('menu').querySelectorAll('button'),function(b){b.onclick=function(){$('menu').classList.remove('open');vscode.postMessage({type:b.dataset.act});};});

inputEl.addEventListener('keydown',function(e){
  if($('popup').classList.contains('open')){if(e.key==='ArrowDown'){popupIndex=Math.min(popupIndex+1,popupItems.length-1);renderPopup();e.preventDefault();return;}if(e.key==='ArrowUp'){popupIndex=Math.max(popupIndex-1,0);renderPopup();e.preventDefault();return;}if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();applyPopup();return;}if(e.key==='Escape'){closePopup();e.preventDefault();return;}}
  var t=active();var streaming=!!(t&&t.streaming);
  if(e.key==='Escape'&&streaming){vscode.postMessage({type:'stop'});return;}
  if((e.key==='ArrowUp'||e.key==='ArrowDown')&&!e.shiftKey&&!e.altKey&&recallHistory(e))return;
  var sendKey=state.settings.sendOnEnter?(e.key==='Enter'&&!e.shiftKey&&!e.altKey&&!e.isComposing):(e.key==='Enter'&&(e.metaKey||e.ctrlKey));
  if(sendKey){e.preventDefault();send(streaming?'steer':'prompt');}
});
inputEl.addEventListener('input',function(){
  var t=active();if(t){if(inputEl.value)drafts[t.id]=inputEl.value;else delete drafts[t.id];}
  histIndex=null;
  autosize();maybePopup();});
/**
 * Up at the top of the box walks back through prompts already sent in this task, Down walks forward
 * and hands back whatever was being typed. Anywhere else in a multi-line prompt, the arrows move the
 * caret as usual.
 */
function recallHistory(e){
  var t=active();if(!t)return false;
  var list=history[t.id]||[];if(!list.length)return false;
  var v=inputEl.value;
  var atTop=inputEl.selectionStart===0&&inputEl.selectionEnd===0;
  var atEnd=inputEl.selectionStart===v.length&&inputEl.selectionEnd===v.length;
  if(e.key==='ArrowUp'){
    if(!atTop&&histIndex===null)return false;
    if(histIndex===null){histStash=v;histIndex=list.length;}
    if(histIndex<=0)return true;
    histIndex--;
  }else{
    if(histIndex===null||!atEnd)return false;
    histIndex++;
    if(histIndex>=list.length){histIndex=null;setInput(histStash);e.preventDefault();return true;}
  }
  setInput(list[histIndex]);
  e.preventDefault();
  return true;
}
/** Park the unsent text with the task it belongs to and bring the new task's text back. */
function swapDraft(nextId){
  var prev=state.activeTaskId;
  if(prev===nextId||!nextId)return;
  if(prev){if(inputEl.value)drafts[prev]=inputEl.value;else delete drafts[prev];}
  histIndex=null;histStash='';
  inputEl.value=drafts[nextId]||'';
  autosize();
}
function setInput(text){inputEl.value=text||'';inputEl.selectionStart=inputEl.selectionEnd=inputEl.value.length;autosize();}
function autosize(){inputEl.style.height='auto';inputEl.style.height=Math.min(inputEl.scrollHeight+2,240)+'px';}
function insertAtCursor(text){var s=inputEl.selectionStart,e=inputEl.selectionEnd;var v=inputEl.value;inputEl.value=v.slice(0,s)+text+v.slice(e);inputEl.selectionStart=inputEl.selectionEnd=s+text.length;autosize();inputEl.focus();}

/* ---------- slash / @ popup ---------- */
function currentToken(){var s=inputEl.selectionStart;var v=inputEl.value.slice(0,s);var m=/(^|\\s)([@\\/][^\\s]*)$/.exec(v);return m?{token:m[2],start:s-m[2].length}:null;}
function maybePopup(){var tk=currentToken();if(!tk){closePopup();return;}var t=active();var info=t?perTask[t.id]||{}:{};
  if(tk.token[0]==='/'&&tk.start===0){var q=tk.token.slice(1).toLowerCase();popupItems=(info.commands||[]).filter(function(c){return c.name.toLowerCase().indexOf(q)===0||c.name.toLowerCase().indexOf(q)>=0;}).slice(0,30).map(function(c){return {label:'/'+c.name,detail:c.description||c.source,insert:'/'+c.name+' '};});popupMode=tk;popupIndex=0;renderPopup();return;}
  if(tk.token==='@'){closePopup();vscode.postMessage({type:'pickFile',replaceFrom:tk.start});return;}
  closePopup();}
function renderPopup(){var p=$('popup');if(!popupItems.length){p.classList.remove('open');return;}p.innerHTML=popupItems.map(function(it,i){return '<div class="'+(i===popupIndex?'sel':'')+'" data-i="'+i+'">'+esc(it.label)+'<small>'+esc(it.detail||'')+'</small></div>';}).join('');p.classList.add('open');
  [].forEach.call(p.querySelectorAll('div[data-i]'),function(n){n.onclick=function(){popupIndex=Number(n.dataset.i);applyPopup();};});}
function applyPopup(){var it=popupItems[popupIndex];if(!it||!popupMode){closePopup();return;}var v=inputEl.value;var end=popupMode.start+popupMode.token.length;inputEl.value=v.slice(0,popupMode.start)+it.insert+v.slice(end);inputEl.selectionStart=inputEl.selectionEnd=popupMode.start+it.insert.length;closePopup();inputEl.focus();autosize();}
function closePopup(){$('popup').classList.remove('open');popupItems=[];popupMode=null;}

/* ---------- find in conversation ---------- */
var findHits=[]; var findAt=-1;

function openFind(){
  var f=$('find');f.hidden=false;
  var sel=String(window.getSelection?window.getSelection():'').trim();
  if(sel&&sel.length<200)$('findInput').value=sel;
  $('findInput').focus();$('findInput').select();
  runFind();
}
function closeFind(){$('find').hidden=true;clearHits();inputEl.focus();}

/** Drop the <mark> wrappers and glue the split text nodes back together. */
function clearHits(){
  var marks=messagesEl.querySelectorAll('mark.hit');
  for(var i=0;i<marks.length;i++){var m=marks[i];var p=m.parentNode;p.replaceChild(document.createTextNode(m.textContent),m);p.normalize();}
  findHits=[];findAt=-1;$('findCount').textContent='';
}

function runFind(){
  clearHits();
  var q=$('findInput').value;
  if(!q){return;}
  var needle=q.toLowerCase();
  var walker=document.createTreeWalker(messagesEl,NodeFilter.SHOW_TEXT,null);
  var targets=[];var node;
  while((node=walker.nextNode())){
    if(node.nodeValue&&node.nodeValue.toLowerCase().indexOf(needle)>=0&&node.parentNode&&node.parentNode.nodeName!=='SCRIPT')targets.push(node);
  }
  for(var i=0;i<targets.length&&findHits.length<500;i++)markNode(targets[i],needle);
  if(findHits.length){findAt=0;focusHit();}
  renderFindCount();
}

function markNode(node,needle){
  var text=node.nodeValue;var lower=text.toLowerCase();var frag=document.createDocumentFragment();var at=0;var idx;
  while((idx=lower.indexOf(needle,at))>=0&&findHits.length<500){
    if(idx>at)frag.appendChild(document.createTextNode(text.slice(at,idx)));
    var mark=document.createElement('mark');mark.className='hit';mark.textContent=text.slice(idx,idx+needle.length);
    frag.appendChild(mark);findHits.push(mark);
    at=idx+needle.length;
  }
  if(at<text.length)frag.appendChild(document.createTextNode(text.slice(at)));
  node.parentNode.replaceChild(frag,node);
}

function renderFindCount(){
  var q=$('findInput').value;
  $('findCount').textContent=!q?'':(findHits.length?(findAt+1)+' of '+findHits.length:'no matches');
}

function stepFind(delta){
  if(!findHits.length)return;
  findHits[findAt]&&findHits[findAt].classList.remove('current');
  findAt=(findAt+delta+findHits.length)%findHits.length;
  focusHit();renderFindCount();
}
function focusHit(){var m=findHits[findAt];if(!m)return;m.classList.add('current');if(m.scrollIntoView)m.scrollIntoView({block:'center'});}

$('findInput').addEventListener('input',runFind);
$('findInput').addEventListener('keydown',function(e){
  if(e.key==='Escape'){e.preventDefault();closeFind();return;}
  if(e.key==='Enter'){e.preventDefault();stepFind(e.shiftKey?-1:1);}
});
$('findNext').onclick=function(){stepFind(1);};
$('findPrev').onclick=function(){stepFind(-1);};
$('findClose').onclick=closeFind;
document.addEventListener('keydown',function(e){
  if((e.metaKey||e.ctrlKey)&&(e.key==='f'||e.key==='F')){e.preventDefault();openFind();return;}
  if(e.key==='Escape'&&!$('find').hidden){e.preventDefault();closeFind();}
});

/* ---------- paste / drop images ---------- */
function addFiles(files){[].forEach.call(files,function(file){if(!file.type||file.type.indexOf('image/')!==0)return;var r=new FileReader();r.onload=function(){var d=String(r.result||'');addChip({kind:'image',label:file.name||file.type,mimeType:file.type,data:d.indexOf(',')>=0?d.split(',')[1]:d});};r.readAsDataURL(file);});}
document.addEventListener('paste',function(e){if(e.clipboardData&&e.clipboardData.files&&e.clipboardData.files.length)addFiles(e.clipboardData.files);});
document.addEventListener('dragover',function(e){e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='copy';});
document.addEventListener('drop',function(e){e.preventDefault();var dt=e.dataTransfer;if(!dt)return;
  // Dragging out of the VS Code explorer (or Finder) hands over uris, not File objects with a usable path.
  var uris=[];
  try{var rl=dt.getData('resourceurls');if(rl)uris=JSON.parse(rl).map(function(u){return decodeURIComponent(u);});}catch(err){}
  if(!uris.length){try{var ul=dt.getData('text/uri-list');if(ul)uris=ul.split(/\\r?\\n/).filter(function(l){return l&&l.charAt(0)!=='#';});}catch(err2){}}
  if(uris.length){vscode.postMessage({type:'dropUris',uris:uris});return;}
  if(dt.files&&dt.files.length)addFiles(dt.files);});

/* ---------- markdown ---------- */
var BT='\\x60';
function md(src){if(!src)return '';var blocks=[];var fence=new RegExp(BT+BT+BT+'([\\\\w+-]*)[^\\\\n]*\\\\n([\\\\s\\\\S]*?)(?:'+BT+BT+BT+'|$)','g');
  var text=src.replace(fence,function(_,lang,code){blocks.push('<pre><button class="copy">copy</button><code class="lang-'+esc(lang)+'">'+esc(code.replace(/\\n$/,''))+'</code></pre>');return '\\u0000'+(blocks.length-1)+'\\u0000';});
  var lines=text.split('\\n');var out=[];var para=[];var list=null;var quote=[];
  function flushPara(){if(para.length){out.push('<p>'+inline(para.join('\\n'))+'</p>');para=[];}}
  function flushList(){if(list){out.push('<'+list.tag+'>'+list.items.map(function(i){return '<li>'+inline(i)+'</li>';}).join('')+'</'+list.tag+'>');list=null;}}
  function flushQuote(){if(quote.length){out.push('<blockquote>'+inline(quote.join('\\n'))+'</blockquote>');quote=[];}}
  for(var i=0;i<lines.length;i++){var l=lines[i];var m;
    if((m=/^\\u0000(\\d+)\\u0000$/.exec(l.trim()))){flushPara();flushList();flushQuote();out.push(blocks[Number(m[1])]);continue;}
    if(!l.trim()){flushPara();flushList();flushQuote();continue;}
    if((m=/^(#{1,4})\\s+(.*)$/.exec(l))){flushPara();flushList();flushQuote();out.push('<h'+m[1].length+'>'+inline(m[2])+'</h'+m[1].length+'>');continue;}
    if(/^(-{3,}|\\*{3,}|_{3,})\\s*$/.test(l)){flushPara();flushList();flushQuote();out.push('<hr>');continue;}
    if((m=/^\\s*[-*+]\\s+(.*)$/.exec(l))){flushPara();flushQuote();if(!list||list.tag!=='ul'){flushList();list={tag:'ul',items:[]};}list.items.push(m[1]);continue;}
    if((m=/^\\s*\\d+[.)]\\s+(.*)$/.exec(l))){flushPara();flushQuote();if(!list||list.tag!=='ol'){flushList();list={tag:'ol',items:[]};}list.items.push(m[1]);continue;}
    if((m=/^>\\s?(.*)$/.exec(l))){flushPara();flushList();quote.push(m[1]);continue;}
    if(/^\\|.*\\|\\s*$/.test(l)&&i+1<lines.length&&/^\\|?\\s*:?-+/.test(lines[i+1])){flushPara();flushList();flushQuote();var rows=[];while(i<lines.length&&/^\\|.*\\|\\s*$/.test(lines[i])){rows.push(lines[i]);i++;}i--;var cells=function(r){return r.replace(/^\\||\\|$/g,'').split('|').map(function(c){return c.trim();});};var head=cells(rows[0]);var body=rows.slice(2).map(cells);out.push('<table><thead><tr>'+head.map(function(c){return '<th>'+inline(c)+'</th>';}).join('')+'</tr></thead><tbody>'+body.map(function(r){return '<tr>'+r.map(function(c){return '<td>'+inline(c)+'</td>';}).join('')+'</tr>';}).join('')+'</tbody></table>');continue;}
    if(list&&/^\\s{2,}\\S/.test(l)){list.items[list.items.length-1]+=' '+l.trim();continue;}
    flushList();flushQuote();para.push(l);}
  flushPara();flushList();flushQuote();return out.join('');}
function inline(s){s=esc(s);var codes=[];s=s.replace(new RegExp(BT+'([^'+BT+']+)'+BT,'g'),function(_,c){codes.push('<code>'+c+'</code>');return '\\u0001'+(codes.length-1)+'\\u0001';});
  s=s.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(/__([^_]+)__/g,'<strong>$1</strong>').replace(/(^|[^*\\w])\\*([^*\\n]+)\\*(?!\\w)/g,'$1<em>$2</em>').replace(/(^|[^_\\w])_([^_\\n]+)_(?!\\w)/g,'$1<em>$2</em>').replace(/~~([^~]+)~~/g,'<del>$1</del>');
  s=s.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+|[^)\\s]+)\\)/g,'<a href="$2">$1</a>').replace(/(^|\\s)(https?:\\/\\/[^\\s<]+)/g,'$1<a href="$2">$2</a>');
  s=s.replace(/\\u0001(\\d+)\\u0001/g,function(_,i){return codes[Number(i)];});return s.replace(/\\n/g,'<br>');}
autosize();
})();
</script></body></html>`;
}
