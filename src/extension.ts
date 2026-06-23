import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as path from 'path';

type RpcCommand = Record<string, unknown>;
type RpcEvent = Record<string, any>;

type Task = {
  id: string;
  name: string;
  cwd: string;
  proc: ChildProcessWithoutNullStreams;
  buffer: string;
  streaming: boolean;
  model?: string;
  messages: UiMessage[];
};

type UiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  text: string;
  toolName?: string;
  status?: string;
};

class PiRpcTask {
  readonly task: Task;
  private onEvent: (task: Task, event: RpcEvent) => void;
  private onExit: (task: Task, code: number | null) => void;
  private req = 0;

  constructor(task: Task, onEvent: (task: Task, event: RpcEvent) => void, onExit: (task: Task, code: number | null) => void) {
    this.task = task;
    this.onEvent = onEvent;
    this.onExit = onExit;
    this.attachReader();
  }

  send(command: RpcCommand) {
    if (!this.task.proc.stdin.writable) return;
    const withId = command.id ? command : { id: `req-${++this.req}`, ...command };
    this.task.proc.stdin.write(`${JSON.stringify(withId)}\n`);
  }

  dispose() {
    try { this.task.proc.kill(); } catch {}
  }

  private attachReader() {
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    this.task.proc.stdout.on('data', chunk => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      while (true) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        try {
          this.onEvent(this.task, JSON.parse(line));
        } catch (e: any) {
          this.onEvent(this.task, { type: 'client_error', error: `Bad JSON from pi: ${e.message}`, line });
        }
      }
    });

    this.task.proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      if (text.trim()) this.onEvent(this.task, { type: 'stderr', text });
    });

    this.task.proc.on('exit', code => this.onExit(this.task, code));
  }
}

class PiCodeProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private tasks = new Map<string, PiRpcTask>();
  private activeTaskId?: string;

  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'ready':
          this.postState();
          if (!this.activeTaskId) await this.newTask();
          break;
        case 'send':
          await this.prompt(String(msg.text || ''), msg.images || []);
          break;
        case 'newTask':
          await this.newTask();
          break;
        case 'switchTask':
          this.activeTaskId = msg.taskId;
          this.postState();
          break;
        case 'stop':
          this.stopActive();
          break;
        case 'restart':
          await this.restartActive();
          break;
        case 'setModel':
          this.setModel(String(msg.modelId || ''));
          break;
        case 'attachImage':
          await this.attachImage();
          break;
      }
    });
  }

  async newTask(name?: string) {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const config = vscode.workspace.getConfiguration('piCode');
    const piCommand = config.get<string>('piCommand') || 'pi';
    const defaultModel = config.get<string>('defaultModel') || '';
    const extraArgs = config.get<string[]>('extraArgs') || [];
    const args = ['--mode', 'rpc', ...extraArgs];
    if (defaultModel) args.push('--model', defaultModel);

    const proc = spawn(piCommand, args, { cwd: folder, env: process.env });
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const task: Task = {
      id,
      name: name || `Task ${this.tasks.size + 1}`,
      cwd: folder,
      proc,
      buffer: '',
      streaming: false,
      model: defaultModel || undefined,
      messages: [{ id: `sys-${id}`, role: 'system', text: `Started Pi RPC in ${folder}` }],
    };
    const rpc = new PiRpcTask(task, (t, e) => this.handleEvent(t, e), (t, code) => this.handleExit(t, code));
    this.tasks.set(id, rpc);
    this.activeTaskId = id;
    rpc.send({ type: 'get_available_models' });
    rpc.send({ type: 'get_state' });
    this.postState();
  }

  stopActive() {
    const rpc = this.activeRpc();
    rpc?.send({ type: 'abort' });
    this.activeTask()?.messages.push({ id: `sys-${Date.now()}`, role: 'system', text: 'Abort sent' });
    this.postState();
  }

  async restartActive() {
    const current = this.activeTask();
    const oldName = current?.name;
    if (current) {
      this.tasks.get(current.id)?.dispose();
      this.tasks.delete(current.id);
    }
    await this.newTask(oldName || undefined);
  }

  async prompt(text: string, images: any[] = []) {
    const task = this.activeTask();
    const rpc = this.activeRpc();
    if (!task || !rpc || !text.trim()) return;
    task.messages.push({ id: `u-${Date.now()}`, role: 'user', text });
    task.messages.push({ id: `a-${Date.now()}`, role: 'assistant', text: '', status: 'streaming' });
    task.streaming = true;
    rpc.send({ type: 'prompt', message: text, images, streamingBehavior: task.streaming ? 'followUp' : undefined });
    this.postState();
  }

  setModel(modelId: string) {
    const rpc = this.activeRpc();
    const task = this.activeTask();
    if (!rpc || !task || !modelId) return;
    const slash = modelId.indexOf('/');
    if (slash > 0) {
      rpc.send({ type: 'set_model', provider: modelId.slice(0, slash), modelId: modelId.slice(slash + 1) });
    } else {
      rpc.send({ type: 'set_model', modelId });
    }
    task.model = modelId;
    this.postState();
  }

  async attachImage() {
    const pick = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
    });
    if (!pick?.length) return;
    const images = pick.map(uri => {
      const data = fs.readFileSync(uri.fsPath).toString('base64');
      const ext = path.extname(uri.fsPath).toLowerCase();
      const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/png';
      return { type: 'image', data, mimeType, fileName: path.basename(uri.fsPath) };
    });
    this.view?.webview.postMessage({ type: 'attachedImages', images: images.map(i => ({ fileName: i.fileName, mimeType: i.mimeType, data: i.data })) });
  }

  private handleEvent(task: Task, event: RpcEvent) {
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent;
      if (delta?.type === 'text_delta') {
        const msg = this.lastAssistant(task);
        msg.text += delta.delta || '';
      }
      if (delta?.type === 'toolcall_start') {
        task.messages.push({ id: `tool-${Date.now()}`, role: 'tool', text: 'Tool call started', toolName: delta.toolCall?.name || 'tool', status: 'running' });
      }
    } else if (event.type === 'tool_execution_start') {
      task.messages.push({ id: event.toolCallId || `tool-${Date.now()}`, role: 'tool', text: JSON.stringify(event.args || {}, null, 2), toolName: event.toolName, status: 'running' });
    } else if (event.type === 'tool_execution_update') {
      const msg = task.messages.find(m => m.id === event.toolCallId) || task.messages[task.messages.length - 1];
      if (msg && msg.role === 'tool') {
        msg.text = extractToolText(event.partialResult) || msg.text;
      }
    } else if (event.type === 'tool_execution_end') {
      const msg = task.messages.find(m => m.id === event.toolCallId) || task.messages[task.messages.length - 1];
      if (msg && msg.role === 'tool') {
        msg.text = extractToolText(event.result) || msg.text;
        msg.status = event.isError ? 'error' : 'done';
      }
    } else if (event.type === 'agent_end') {
      task.streaming = false;
      const msg = this.lastAssistant(task);
      msg.status = 'done';
      const firstUser = task.messages.find(m => m.role === 'user')?.text;
      if (firstUser && task.name.startsWith('Task ')) task.name = firstUser.slice(0, 40).replace(/\s+/g, ' ');
    } else if (event.type === 'response') {
      if (event.command === 'get_available_models' && event.success) {
        this.view?.webview.postMessage({ type: 'models', models: event.data?.models || [] });
      }
      if (event.command === 'set_model' && event.success) {
        task.model = event.data?.provider && event.data?.id ? `${event.data.provider}/${event.data.id}` : task.model;
      }
      if (!event.success) {
        task.messages.push({ id: `err-${Date.now()}`, role: 'error', text: event.error || 'RPC command failed' });
      }
    } else if (event.type === 'stderr') {
      task.messages.push({ id: `err-${Date.now()}`, role: 'error', text: event.text });
    } else if (event.type === 'client_error') {
      task.messages.push({ id: `err-${Date.now()}`, role: 'error', text: event.error });
    }
    this.postState();
  }

  private handleExit(task: Task, code: number | null) {
    task.streaming = false;
    task.messages.push({ id: `sys-${Date.now()}`, role: 'system', text: `Pi exited (${code ?? 'signal'})` });
    this.postState();
  }

  private lastAssistant(task: Task): UiMessage {
    let msg = [...task.messages].reverse().find(m => m.role === 'assistant');
    if (!msg) {
      msg = { id: `a-${Date.now()}`, role: 'assistant', text: '' };
      task.messages.push(msg);
    }
    return msg;
  }

  private activeTask() { return this.activeTaskId ? this.tasks.get(this.activeTaskId)?.task : undefined; }
  private activeRpc() { return this.activeTaskId ? this.tasks.get(this.activeTaskId) : undefined; }

  private postState() {
    const tasks = [...this.tasks.values()].map(r => ({
      id: r.task.id,
      name: r.task.name,
      cwd: r.task.cwd,
      streaming: r.task.streaming,
      model: r.task.model,
      messages: r.task.messages,
    }));
    this.view?.webview.postMessage({ type: 'state', activeTaskId: this.activeTaskId, tasks });
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  :root{--bg:var(--vscode-editor-background);--fg:var(--vscode-editor-foreground);--muted:var(--vscode-descriptionForeground);--border:var(--vscode-panel-border);--accent:var(--vscode-button-background);--accentFg:var(--vscode-button-foreground);--input:var(--vscode-input-background)}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--vscode-font-family);font-size:13px;height:100vh;display:flex;overflow:hidden}
  .tasks{width:190px;border-right:1px solid var(--border);display:flex;flex-direction:column;min-width:150px}
  .task{padding:8px;border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .task.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
  .task small{display:block;color:var(--muted);overflow:hidden;text-overflow:ellipsis}
  .main{flex:1;display:flex;flex-direction:column;min-width:0}
  .toolbar{display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--border);align-items:center}
  button{background:var(--accent);color:var(--accentFg);border:0;padding:5px 9px;border-radius:3px;cursor:pointer}
  button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  select{background:var(--input);color:var(--fg);border:1px solid var(--border);padding:4px;max-width:260px}
  .messages{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
  .msg{border:1px solid var(--border);border-radius:6px;padding:9px;white-space:pre-wrap;line-height:1.4}
  .user{background:color-mix(in srgb,var(--accent) 12%,transparent)}
  .assistant{background:var(--vscode-editorWidget-background)}
  .tool{font-family:var(--vscode-editor-font-family);font-size:12px;color:var(--muted)}
  .error{border-color:var(--vscode-errorForeground);color:var(--vscode-errorForeground)}
  .system{color:var(--muted)}
  .role{font-size:11px;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
  .composer{border-top:1px solid var(--border);padding:8px;display:flex;flex-direction:column;gap:6px}
  textarea{height:78px;resize:vertical;background:var(--input);color:var(--fg);border:1px solid var(--border);padding:8px;font-family:var(--vscode-font-family)}
  .row{display:flex;gap:6px;align-items:center}.grow{flex:1}.attachments{font-size:12px;color:var(--muted)}
</style></head>
<body>
  <div class="tasks"><div class="toolbar"><button id="newTask">New</button><button class="secondary" id="restart">Restart</button></div><div id="tasks"></div></div>
  <div class="main">
    <div class="toolbar"><select id="models"><option value="">Model</option></select><button class="secondary" id="stop">Stop</button><span class="grow"></span><span id="status"></span></div>
    <div class="messages" id="messages"></div>
    <div class="composer"><div class="attachments" id="attachments"></div><textarea id="input" placeholder="Ask Pi..."></textarea><div class="row"><button id="send">Send</button><button class="secondary" id="attach">Attach image</button><span class="grow"></span><span class="attachments">Ctrl/Cmd+Enter to send</span></div></div>
  </div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let state={tasks:[],activeTaskId:null};let models=[];let pendingImages=[];
const el=id=>document.getElementById(id);
vscode.postMessage({type:'ready'});
window.addEventListener('message',e=>{const m=e.data;if(m.type==='state'){state=m;render();} if(m.type==='models'){models=m.models||[];renderModels();} if(m.type==='attachedImages'){pendingImages=[...pendingImages,...(m.images||[])];renderAttachments();}});
function render(){renderTasks();renderMessages();renderStatus();}
function active(){return state.tasks.find(t=>t.id===state.activeTaskId)}
function renderTasks(){el('tasks').innerHTML=state.tasks.map(t=>'<div class="task '+(t.id===state.activeTaskId?'active':'')+'" data-id="'+t.id+'">'+esc(t.name)+'<small>'+(t.streaming?'running':'idle')+(t.model?' · '+esc(t.model):'')+'</small></div>').join('');document.querySelectorAll('.task').forEach(n=>n.onclick=()=>vscode.postMessage({type:'switchTask',taskId:n.dataset.id}));}
function renderMessages(){const t=active();el('messages').innerHTML=!t?'':t.messages.map(m=>'<div class="msg '+m.role+'"><div class="role">'+esc(m.role)+(m.toolName?' · '+esc(m.toolName):'')+(m.status?' · '+esc(m.status):'')+'</div>'+esc(m.text)+'</div>').join('');el('messages').scrollTop=el('messages').scrollHeight;}
function renderStatus(){const t=active();el('status').textContent=t?(t.streaming?'Running':'Idle'):'';}
function renderModels(){el('models').innerHTML='<option value="">Model</option>'+models.map(m=>'<option value="'+escAttr((m.provider?m.provider+'/':'')+m.id)+'">'+esc((m.name||m.id)+' · '+(m.provider||''))+'</option>').join('');}
function renderAttachments(){el('attachments').textContent=pendingImages.length?('Attached: '+pendingImages.map(i=>i.fileName||i.mimeType).join(', ')):'';}
function send(){const text=el('input').value.trim();if(!text)return;vscode.postMessage({type:'send',text,images:pendingImages.map(i=>({type:'image',data:i.data,mimeType:i.mimeType}))});el('input').value='';pendingImages=[];renderAttachments();}
el('send').onclick=send;el('newTask').onclick=()=>vscode.postMessage({type:'newTask'});el('stop').onclick=()=>vscode.postMessage({type:'stop'});el('restart').onclick=()=>vscode.postMessage({type:'restart'});el('attach').onclick=()=>vscode.postMessage({type:'attachImage'});el('models').onchange=e=>vscode.postMessage({type:'setModel',modelId:e.target.value});el('input').addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter')send();});
function esc(s){return String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
</script></body></html>`;
  }

  dispose() {
    for (const rpc of this.tasks.values()) rpc.dispose();
    this.tasks.clear();
  }
}

function extractToolText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) return content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
  if (typeof result === 'string') return result;
  if (result) return JSON.stringify(result, null, 2);
  return '';
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new PiCodeProvider(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('piCode.chatView', provider));
  context.subscriptions.push(vscode.commands.registerCommand('piCode.newTask', () => provider.newTask()));
  context.subscriptions.push(vscode.commands.registerCommand('piCode.stopTask', () => provider.stopActive()));
  context.subscriptions.push(vscode.commands.registerCommand('piCode.restartTask', () => provider.restartActive()));
  context.subscriptions.push({ dispose: () => provider.dispose() });
}

export function deactivate() {}
