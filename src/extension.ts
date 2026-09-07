import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PiProcess, RpcEvent, RpcResponse, augmentedEnv, resolvePiCommand } from './pi-process';
import { Conversation, UiImage, UiMessage, nextId } from './conversation';
import { listSessions, SessionInfo } from './sessions';
import { renderWebviewHtml } from './webview';

type ContextChip = { kind: 'selection' | 'file'; path: string; label: string; startLine?: number; endLine?: number; text: string; language?: string };

type Task = {
  id: string;
  name: string;
  cwd: string;
  proc?: PiProcess;
  conv: Conversation;
  model?: string;
  thinking?: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  stats?: any;
  widgets: Record<string, string[]>;
  lastError?: string;
  alive: boolean;
  models: any[];
  levels: string[];
  commands: any[];
  currentBashId?: string;
  bashReqId?: string;
};

type PersistedTask = { name: string; cwd: string; model?: string; sessionFile?: string; sessionId?: string; messages?: UiMessage[] };

const TASKS_STATE_KEY = 'piCode.tasks';
const ACTIVE_TASK_STATE_KEY = 'piCode.activeTaskId';

class PiCodeProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private tasks = new Map<string, Task>();
  private activeTaskId?: string;
  private restored = false;
  private status: vscode.StatusBarItem;
  private renderTimer?: NodeJS.Timeout;
  private output: vscode.OutputChannel;

  constructor(private context: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.name = 'Pi Code';
    this.output = vscode.window.createOutputChannel('Pi Code');
    context.subscriptions.push(this.status, this.output);
  }

  /* ------------------------------------------------------------------ webview */

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    view.webview.html = renderWebviewHtml(view.webview.cspSource, nonce);
    view.onDidChangeVisibility(() => {
      if (view.visible) this.postState();
    });
    view.webview.onDidReceiveMessage(msg => this.onWebviewMessage(msg).catch(err => this.report(err)));
  }

  private async onWebviewMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready':
        if (!this.restored) {
          this.restored = true;
          await this.restoreTasks();
        }
        if (!this.tasks.size) await this.newTask();
        this.postState();
        for (const t of this.tasks.values()) this.postTaskInfo(t);
        break;
      case 'send':
        await this.send(msg.mode || 'prompt', String(msg.text || ''), msg.images || [], msg.context || []);
        break;
      case 'stop':
        await this.stopActive();
        break;
      case 'newTask':
        await this.newTask();
        break;
      case 'closeTask':
        this.closeTask(msg.taskId);
        break;
      case 'switchTask':
        if (this.tasks.has(msg.taskId)) {
          this.activeTaskId = msg.taskId;
          this.postState();
          const t = this.tasks.get(msg.taskId)!;
          this.postTaskInfo(t);
        }
        break;
      case 'restart':
        await this.restartActive();
        break;
      case 'rename':
        await this.renameActive();
        break;
      case 'resume':
        await this.resumeSession();
        break;
      case 'newSession':
        await this.newSessionInActive();
        break;
      case 'compact':
        await this.compactActive();
        break;
      case 'exportHtml':
        await this.exportActiveHtml();
        break;
      case 'copySessionPath':
        await this.copySessionPath();
        break;
      case 'setModel':
        await this.setModel(String(msg.modelId || ''));
        break;
      case 'setThinking':
        await this.setThinking(String(msg.level || ''));
        break;
      case 'attachImage':
        await this.attachImage();
        break;
      case 'addSelection':
        await this.addSelection();
        break;
      case 'pickFile':
        await this.pickFile(typeof msg.replaceFrom === 'number' ? msg.replaceFrom : undefined);
        break;
      case 'openFile':
        await this.openFile(String(msg.path || ''), msg.line);
        break;
      case 'openDiff':
        await this.openDiff(String(msg.path || ''));
        break;
      case 'openLink':
        if (typeof msg.href === 'string') {
          if (/^https?:/.test(msg.href)) await vscode.env.openExternal(vscode.Uri.parse(msg.href));
          else await this.openFile(msg.href);
        }
        break;
      case 'copyText':
        await vscode.env.clipboard.writeText(String(msg.text || ''));
        break;
    }
  }

  /* ------------------------------------------------------------------ tasks */

  private config() {
    return vscode.workspace.getConfiguration('piCode');
  }

  private workspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  }

  async newTask(opts: { name?: string; cwd?: string; sessionFile?: string; model?: string; messages?: UiMessage[] } = {}): Promise<Task> {
    const cwd = opts.cwd || this.workspaceCwd();
    const id = nextId('task');
    const task: Task = {
      id,
      name: opts.name || `Task ${this.tasks.size + 1}`,
      cwd,
      conv: new Conversation(cwd),
      model: opts.model,
      sessionFile: opts.sessionFile,
      widgets: {},
      alive: false,
      models: [],
      levels: [],
      commands: [],
    };
    if (opts.messages?.length) task.conv.messages = opts.messages;
    this.tasks.set(id, task);
    this.activeTaskId = id;
    this.postState();
    await this.spawn(task, { model: opts.model, sessionFile: opts.sessionFile, fresh: !opts.sessionFile && !opts.messages });
    return task;
  }

  private async spawn(task: Task, opts: { model?: string; sessionFile?: string; fresh: boolean }): Promise<void> {
    const cfg = this.config();
    const env = augmentedEnv();
    const command = resolvePiCommand(cfg.get<string>('piCommand'), env);
    const model = opts.model || cfg.get<string>('defaultModel') || '';
    const args = ['--mode', 'rpc', ...(cfg.get<string[]>('extraArgs') || [])];
    if (model) args.push('--model', model);

    let proc: PiProcess;
    try {
      proc = new PiProcess({ command, args, cwd: task.cwd, env });
    } catch (err: any) {
      task.alive = false;
      task.conv.system(`Failed to start pi (${command}): ${err.message}. Set piCode.piCommand to the full path.`, 'error');
      this.postState();
      return;
    }
    task.proc = proc;
    task.alive = true;
    task.lastError = undefined;
    proc.on('event', (e: RpcEvent) => this.onEvent(task, e));
    proc.on('stderr', (text: string) => {
      this.output.appendLine(`[${task.name}] ${text.trimEnd()}`);
      if (/error|exception|failed/i.test(text) && !/warn/i.test(text)) task.conv.system(text.trim(), 'warning');
      this.scheduleRender();
    });
    proc.on('error', (err: Error) => {
      task.alive = false;
      task.lastError = err.message;
      task.conv.system(`Failed to start pi (${command}): ${err.message}. Set piCode.piCommand to the full path of the pi executable.`, 'error');
      this.postState();
    });
    proc.on('exit', (code: number | null) => {
      if (task.proc !== proc) return;
      task.alive = false;
      task.conv.markAborted();
      task.conv.system(`pi exited (${code ?? 'signal'})`, code ? 'error' : 'system');
      this.postState();
    });

    try {
      if (opts.sessionFile && fs.existsSync(opts.sessionFile)) {
        const r = await proc.request({ type: 'switch_session', sessionPath: opts.sessionFile });
        if (r.success && !r.data?.cancelled) {
          const msgs = await proc.request({ type: 'get_messages' });
          if (msgs.success) task.conv.load(msgs.data?.messages || []);
        } else {
          task.conv.system(`Could not reopen session: ${r.error || 'cancelled'}`, 'warning');
        }
      } else if (opts.sessionFile) {
        task.conv.system('Previous session file is gone, started a new one.', 'warning');
      }
      await this.refreshState(task);
      const level = cfg.get<string>('defaultThinkingLevel');
      if (opts.fresh && level && task.levels.includes(level) && task.thinking !== level) {
        const r = await proc.request({ type: 'set_thinking_level', level });
        if (r.success) task.thinking = level;
      }
      this.loadTaskInfo(task).catch(err => this.report(err));
    } catch (err: any) {
      task.conv.system(`pi did not answer: ${err.message}`, 'error');
    }
    this.postState();
  }

  private async refreshState(task: Task): Promise<void> {
    if (!task.proc?.alive) return;
    const r = await task.proc.request({ type: 'get_state' });
    if (!r.success) return;
    const d = r.data || {};
    task.sessionFile = d.sessionFile || task.sessionFile;
    task.sessionId = d.sessionId || task.sessionId;
    task.sessionName = d.sessionName || undefined;
    task.thinking = d.thinkingLevel;
    if (d.model?.id) task.model = `${d.model.provider ? d.model.provider + '/' : ''}${d.model.id}`;
    if (task.sessionName && task.name.startsWith('Task ')) task.name = task.sessionName;
    const lv = await task.proc.request({ type: 'get_available_thinking_levels' });
    if (lv.success) task.levels = lv.data?.levels || [];
  }

  private async loadTaskInfo(task: Task): Promise<void> {
    if (!task.proc?.alive) return;
    const [models, commands] = await Promise.all([task.proc.request({ type: 'get_available_models' }), task.proc.request({ type: 'get_commands' })]);
    if (models.success) task.models = models.data?.models || [];
    if (commands.success) task.commands = commands.data?.commands || [];
    this.postTaskInfo(task);
  }

  private postTaskInfo(task: Task): void {
    this.view?.webview.postMessage({ type: 'models', taskId: task.id, models: task.models.map(m => ({ id: m.id, name: m.name, provider: m.provider, reasoning: m.reasoning, input: m.input })) });
    this.view?.webview.postMessage({ type: 'thinkingLevels', taskId: task.id, levels: task.levels });
    this.view?.webview.postMessage({ type: 'commands', taskId: task.id, commands: task.commands.map(c => ({ name: c.name, description: c.description, source: c.source })) });
  }

  closeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.proc?.kill();
    this.tasks.delete(taskId);
    if (this.activeTaskId === taskId) this.activeTaskId = [...this.tasks.keys()].pop();
    this.postState();
  }

  async restartActive(): Promise<void> {
    const task = this.activeTask();
    if (!task) return;
    task.proc?.kill();
    task.proc = undefined;
    task.conv.markAborted();
    task.conv.system('Restarting pi…');
    this.postState();
    await this.spawn(task, { model: task.model, sessionFile: task.sessionFile, fresh: false });
  }

  private async restoreTasks(): Promise<void> {
    if (!this.config().get<boolean>('restoreTasks', true)) return;
    const saved = this.context.workspaceState.get<PersistedTask[]>(TASKS_STATE_KEY, []);
    if (!saved.length) return;
    const activeIndex = this.context.workspaceState.get<number>(ACTIVE_TASK_STATE_KEY, 0);
    for (const item of saved.slice(0, 8)) {
      await this.newTask({ name: item.name, cwd: item.cwd, sessionFile: item.sessionFile, model: item.model, messages: item.sessionFile ? undefined : item.messages });
    }
    const ids = [...this.tasks.keys()];
    this.activeTaskId = ids[Math.min(activeIndex, ids.length - 1)] || ids[0];
  }

  private persistTasks(): void {
    const tasks: PersistedTask[] = [...this.tasks.values()].map(t => ({
      name: t.name,
      cwd: t.cwd,
      model: t.model,
      sessionFile: t.sessionFile,
      sessionId: t.sessionId,
      messages: t.sessionFile ? undefined : t.conv.messages.slice(-100),
    }));
    const activeIndex = [...this.tasks.keys()].indexOf(this.activeTaskId || '');
    void this.context.workspaceState.update(TASKS_STATE_KEY, tasks);
    void this.context.workspaceState.update(ACTIVE_TASK_STATE_KEY, Math.max(activeIndex, 0));
  }

  /* ------------------------------------------------------------------ events */

  private onEvent(task: Task, event: RpcEvent): void {
    if (event.type === 'extension_ui_request') {
      this.handleExtensionUi(task, event).catch(err => this.report(err));
      return;
    }
    if (event.type === 'bash_execution_update') {
      if (task.currentBashId && event.id === task.bashReqId) task.conv.appendBash(task.currentBashId, event.delta || '');
      this.scheduleRender();
      return;
    }
    const wasStreaming = task.conv.streaming;
    const changed = task.conv.apply(event);
    if (event.type === 'agent_settled' || (wasStreaming && !task.conv.streaming)) {
      this.afterRun(task).catch(err => this.report(err));
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message.stopReason === 'error') {
      task.lastError = event.message.errorMessage;
    }
    if (changed) this.scheduleRender();
  }

  private async afterRun(task: Task): Promise<void> {
    if (!task.proc?.alive) return;
    const [stats] = await Promise.all([task.proc.request({ type: 'get_session_stats' }), this.refreshState(task)]);
    if (stats.success) task.stats = stats.data;
    const firstUser = task.conv.messages.find(m => m.role === 'user');
    if (firstUser && firstUser.role === 'user' && task.name.startsWith('Task ') && !task.sessionName) {
      task.name = firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 40) || task.name;
    }
    this.postState();
  }

  private async handleExtensionUi(task: Task, req: RpcEvent): Promise<void> {
    const proc = task.proc;
    if (!proc) return;
    const title = req.title || 'pi';
    switch (req.method) {
      case 'select': {
        const value = await vscode.window.showQuickPick((req.options || []).map(String), { title, placeHolder: req.message || title, ignoreFocusOut: true });
        proc.respondUi(req.id, value === undefined ? { cancelled: true } : { value });
        break;
      }
      case 'confirm': {
        const answer = await vscode.window.showWarningMessage(title, { modal: true, detail: req.message }, 'Yes', 'No');
        proc.respondUi(req.id, answer === undefined ? { cancelled: true } : { confirmed: answer === 'Yes' });
        break;
      }
      case 'input': {
        const value = await vscode.window.showInputBox({ title, prompt: req.message, placeHolder: req.placeholder, ignoreFocusOut: true });
        proc.respondUi(req.id, value === undefined ? { cancelled: true } : { value });
        break;
      }
      case 'editor': {
        const value = await this.editInDocument(title, req.prefill || '');
        proc.respondUi(req.id, value === undefined ? { cancelled: true } : { value });
        break;
      }
      case 'notify': {
        const text = String(req.message || '');
        if (req.notifyType === 'error') vscode.window.showErrorMessage(text);
        else if (req.notifyType === 'warning') vscode.window.showWarningMessage(text);
        else vscode.window.showInformationMessage(text);
        break;
      }
      case 'setStatus': {
        if (req.statusText) {
          this.status.text = `$(hubot) ${req.statusText}`;
          this.status.show();
        } else {
          this.status.hide();
        }
        break;
      }
      case 'setWidget': {
        if (Array.isArray(req.widgetLines) && req.widgetLines.length) task.widgets[req.widgetKey || 'default'] = req.widgetLines.map(String);
        else delete task.widgets[req.widgetKey || 'default'];
        this.scheduleRender();
        break;
      }
      case 'set_editor_text':
        this.view?.webview.postMessage({ type: 'setEditorText', text: req.text || '' });
        break;
      default:
        break;
    }
  }

  /** Multi-line editor request: open an untitled document and take its content when the user closes it. */
  private async editInDocument(title: string, prefill: string): Promise<string | undefined> {
    const doc = await vscode.workspace.openTextDocument({ content: prefill, language: 'markdown' });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.setStatusBarMessage(`Pi: ${title}. Close the editor tab to submit, or use "Pi Code: Submit editor" from the notification.`, 15000);
    const choice = await vscode.window.showInformationMessage(`pi asks: ${title}. Edit the opened document, then choose:`, 'Submit', 'Cancel');
    const text = editor.document.getText();
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor').then(undefined, () => undefined);
    return choice === 'Submit' ? text : undefined;
  }

  /* ------------------------------------------------------------------ prompting */

  private async send(mode: 'prompt' | 'steer' | 'followUp', text: string, images: UiImage[], context: ContextChip[]): Promise<void> {
    const task = this.activeTask();
    if (!task) return;
    if (!task.proc?.alive) {
      vscode.window.showWarningMessage('pi is not running for this task. Restart it from the ⋯ menu.');
      return;
    }
    if (text.startsWith('!') && mode === 'prompt' && !task.conv.streaming) {
      await this.runBash(task, text.slice(1).trim());
      return;
    }
    const message = this.buildMessage(text, context);
    task.conv.addUser(message, images);
    if (mode === 'prompt' && task.conv.streaming) mode = 'steer';
    this.postState();
    let response: RpcResponse;
    if (mode === 'prompt') {
      task.conv.streaming = true;
      response = await task.proc.request({ type: 'prompt', message, images: images.length ? images.map(i => ({ type: 'image', data: i.data, mimeType: i.mimeType })) : undefined });
    } else {
      response = await task.proc.request({ type: mode === 'steer' ? 'steer' : 'follow_up', message, images: images.length ? images.map(i => ({ type: 'image', data: i.data, mimeType: i.mimeType })) : undefined });
    }
    if (!response.success) {
      task.conv.streaming = false;
      task.conv.system(response.error || 'pi rejected the prompt', 'error');
      this.postState();
    }
  }

  private buildMessage(text: string, context: ContextChip[]): string {
    const parts = [text.trim()];
    const chips = [...context];
    const cfg = this.config();
    const maxBytes = (cfg.get<number>('contextFileMaxKb') || 96) * 1024;
    // @path mentions typed by hand resolve to files inside the workspace.
    const cwd = this.activeTask()?.cwd || this.workspaceCwd();
    for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
      const rel = m[1].replace(/[),.;:]+$/, '');
      const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
      if (chips.some(c => c.path === abs)) continue;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        if (st.size > maxBytes) {
          chips.push({ kind: 'file', path: abs, label: rel, text: `[file too large to inline: ${st.size} bytes, read it with the read tool]` });
          continue;
        }
        chips.push({ kind: 'file', path: abs, label: rel, text: fs.readFileSync(abs, 'utf8') });
      } catch {
        /* not a file, leave the mention as plain text */
      }
    }
    for (const c of chips) {
      const rel = path.isAbsolute(c.path) && c.path.startsWith(cwd) ? path.relative(cwd, c.path) : c.path;
      const where = c.kind === 'selection' && c.startLine ? `${rel}:${c.startLine}${c.endLine && c.endLine !== c.startLine ? `-${c.endLine}` : ''}` : rel;
      const fence = c.text.includes('```') ? '````' : '```';
      parts.push(`${c.kind === 'selection' ? 'Selected code from' : 'File'} ${where}:\n${fence}${c.language || ''}\n${c.text.replace(/\n$/, '')}\n${fence}`);
    }
    return parts.filter(Boolean).join('\n\n');
  }

  private async runBash(task: Task, command: string): Promise<void> {
    if (!command || !task.proc) return;
    const id = task.conv.addBash(command);
    task.currentBashId = id;
    task.bashReqId = `bash-${id}`;
    this.postState();
    const r = await task.proc.request({ id: task.bashReqId, type: 'bash', command });
    task.currentBashId = undefined;
    if (r.success) {
      const d = r.data || {};
      task.conv.finishBash(id, d.output || '', d.exitCode, d.exitCode !== 0 && d.exitCode != null);
      if (d.truncated && d.fullOutputPath) task.conv.system(`Output truncated, full log: ${d.fullOutputPath}`);
    } else {
      task.conv.finishBash(id, r.error || 'bash failed', null, true);
    }
    this.postState();
  }

  async stopActive(): Promise<void> {
    const task = this.activeTask();
    if (!task?.proc?.alive) return;
    const cleared = await task.proc.request({ type: 'clear_queue' });
    const texts = cleared.success ? [...(cleared.data?.steering || []), ...(cleared.data?.followUp || [])] : [];
    if (task.currentBashId) task.proc.send({ type: 'abort_bash' });
    await task.proc.request({ type: 'abort' });
    task.proc.send({ type: 'abort_retry' });
    task.conv.markAborted();
    task.conv.system('Stopped');
    if (texts.length) this.view?.webview.postMessage({ type: 'restoreQueued', texts });
    this.postState();
  }

  async setModel(modelId: string): Promise<void> {
    const task = this.activeTask();
    if (!task?.proc?.alive || !modelId) return;
    const slash = modelId.indexOf('/');
    const cmd = slash > 0 ? { type: 'set_model', provider: modelId.slice(0, slash), modelId: modelId.slice(slash + 1) } : { type: 'set_model', modelId };
    const r = await task.proc.request(cmd);
    if (r.success) {
      task.model = r.data?.id ? `${r.data.provider ? r.data.provider + '/' : ''}${r.data.id}` : modelId;
      await this.refreshState(task);
      this.postTaskInfo(task);
    } else {
      task.conv.system(r.error || 'Could not switch model', 'error');
    }
    this.postState();
  }

  async setThinking(level: string): Promise<void> {
    const task = this.activeTask();
    if (!task?.proc?.alive || !level) return;
    const r = await task.proc.request({ type: 'set_thinking_level', level });
    if (r.success) task.thinking = level;
    else task.conv.system(r.error || 'Could not set thinking level', 'error');
    this.postState();
  }

  async compactActive(): Promise<void> {
    const task = this.activeTask();
    if (!task?.proc?.alive) return;
    const r = await task.proc.request({ type: 'compact' });
    if (!r.success) task.conv.system(r.error || 'Compaction failed', 'error');
    await this.afterRun(task);
  }

  async newSessionInActive(): Promise<void> {
    const task = this.activeTask();
    if (!task?.proc?.alive) return;
    if (task.conv.messages.some(m => m.role === 'user')) {
      const ok = await vscode.window.showWarningMessage('Start a new pi session in this task? The current history stays on disk and can be resumed later.', { modal: true }, 'New session');
      if (ok !== 'New session') return;
    }
    const r = await task.proc.request({ type: 'new_session' });
    if (!r.success || r.data?.cancelled) {
      task.conv.system(r.error || 'New session cancelled', 'warning');
    } else {
      task.conv = new Conversation(task.cwd);
      task.stats = undefined;
      task.sessionName = undefined;
      task.name = `Task ${[...this.tasks.keys()].indexOf(task.id) + 1}`;
      await this.refreshState(task);
    }
    this.postState();
  }

  async renameActive(): Promise<void> {
    const task = this.activeTask();
    if (!task) return;
    const name = await vscode.window.showInputBox({ title: 'Rename Pi Code task', value: task.name, prompt: 'Shown in the tab strip and stored as the pi session name' });
    if (!name?.trim()) return;
    task.name = name.trim();
    task.sessionName = task.name;
    task.proc?.send({ type: 'set_session_name', name: task.name });
    this.postState();
  }

  async copySessionPath(): Promise<void> {
    const task = this.activeTask();
    if (!task?.sessionFile) {
      vscode.window.showInformationMessage('Pi session path is not available yet.');
      return;
    }
    await vscode.env.clipboard.writeText(task.sessionFile);
    vscode.window.showInformationMessage('Pi session path copied.');
  }

  async exportActiveHtml(): Promise<void> {
    const task = this.activeTask();
    if (!task?.proc?.alive) return;
    const r = await task.proc.request({ type: 'export_html' });
    if (r.success && r.data?.path) {
      const open = await vscode.window.showInformationMessage(`Exported to ${r.data.path}`, 'Open');
      if (open) await vscode.env.openExternal(vscode.Uri.file(r.data.path));
    } else {
      task.conv.system(r.error || 'Export failed', 'error');
      this.postState();
    }
  }

  async resumeSession(): Promise<void> {
    const cwd = this.workspaceCwd();
    const sessions = listSessions(cwd);
    if (!sessions.length) {
      vscode.window.showInformationMessage(`No pi sessions recorded for ${cwd}.`);
      return;
    }
    const open = new Set([...this.tasks.values()].map(t => t.sessionFile));
    const items = sessions.map(s => ({
      label: (s.name || s.firstPrompt || path.basename(s.file)).slice(0, 80),
      description: `${fmtDate(s.modifiedAt)} · ${s.messageCount} msgs${open.has(s.file) ? ' · open' : ''}`,
      detail: s.name && s.firstPrompt ? s.firstPrompt : undefined,
      session: s as SessionInfo,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: 'Resume pi session', placeHolder: 'Sessions for this workspace, newest first', matchOnDescription: true, matchOnDetail: true });
    if (!pick) return;
    const existing = [...this.tasks.values()].find(t => t.sessionFile === pick.session.file);
    if (existing) {
      this.activeTaskId = existing.id;
      this.postState();
      return;
    }
    await this.newTask({ name: pick.label, cwd, sessionFile: pick.session.file });
  }

  /* ------------------------------------------------------------------ editor integration */

  async addSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Open a file and select code first.');
      return;
    }
    const sel = editor.selection;
    const whole = sel.isEmpty;
    const range = whole ? new vscode.Range(0, 0, editor.document.lineCount, 0) : new vscode.Range(sel.start.line, 0, sel.end.line, editor.document.lineAt(sel.end.line).text.length);
    const text = editor.document.getText(range);
    const file = editor.document.uri.fsPath;
    const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
    const chip: ContextChip = {
      kind: whole ? 'file' : 'selection',
      path: file,
      label: whole ? rel : `${rel}:${range.start.line + 1}-${range.end.line + 1}`,
      startLine: whole ? undefined : range.start.line + 1,
      endLine: whole ? undefined : range.end.line + 1,
      text,
      language: editor.document.languageId,
    };
    await this.focus();
    this.view?.webview.postMessage({ type: 'addContext', chip });
  }

  async addFile(uri?: vscode.Uri): Promise<void> {
    const target = uri || vscode.window.activeTextEditor?.document.uri;
    if (!target) return;
    const maxBytes = (this.config().get<number>('contextFileMaxKb') || 96) * 1024;
    let text: string;
    try {
      const st = fs.statSync(target.fsPath);
      text = st.size > maxBytes ? `[file too large to inline: ${st.size} bytes, read it with the read tool]` : fs.readFileSync(target.fsPath, 'utf8');
    } catch (err: any) {
      vscode.window.showWarningMessage(`Cannot read ${target.fsPath}: ${err.message}`);
      return;
    }
    await this.focus();
    this.view?.webview.postMessage({ type: 'addContext', chip: { kind: 'file', path: target.fsPath, label: vscode.workspace.asRelativePath(target, false), text } });
  }

  private async pickFile(replaceFrom?: number): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**,**/tmp/**,**/log/**,**/vendor/bundle/**}', 4000);
    const items = files
      .map(f => vscode.workspace.asRelativePath(f, false))
      .sort()
      .map(rel => ({ label: rel }));
    const pick = await vscode.window.showQuickPick(items, { title: 'Mention a file', placeHolder: 'Type to filter workspace files', matchOnDescription: true });
    await this.focus();
    if (!pick) return;
    this.view?.webview.postMessage({ type: 'insertMention', path: pick.label, replaceFrom });
  }

  private async openFile(p: string, line?: number): Promise<void> {
    if (!p) return;
    const cwd = this.activeTask()?.cwd || this.workspaceCwd();
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    try {
      const doc = await vscode.workspace.openTextDocument(abs);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (typeof line === 'number' && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch (err: any) {
      vscode.window.showWarningMessage(`Cannot open ${abs}: ${err.message}`);
    }
  }

  /** Diff the working copy against git HEAD through the built-in git extension; falls back to opening the file. */
  private async openDiff(p: string): Promise<void> {
    const cwd = this.activeTask()?.cwd || this.workspaceCwd();
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    const uri = vscode.Uri.file(abs);
    const git = vscode.extensions.getExtension<any>('vscode.git');
    try {
      const api = git?.isActive ? git.exports.getAPI(1) : (await git?.activate())?.getAPI(1);
      const repo = api?.repositories?.find((r: any) => abs.startsWith(r.rootUri.fsPath));
      if (api && repo) {
        const head = api.toGitUri(uri, 'HEAD');
        await vscode.commands.executeCommand('vscode.diff', head, uri, `${path.basename(abs)} (HEAD ↔ working tree)`);
        return;
      }
    } catch (err: any) {
      this.output.appendLine(`diff fallback: ${err.message}`);
    }
    await this.openFile(abs);
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand('piCode.chatView.focus');
    this.view?.webview.postMessage({ type: 'focusInput' });
  }

  private async attachImage(): Promise<void> {
    const pick = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: true, filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] } });
    if (!pick?.length) return;
    const images = pick.map(uri => {
      const ext = path.extname(uri.fsPath).toLowerCase();
      const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/png';
      return { fileName: path.basename(uri.fsPath), mimeType, data: fs.readFileSync(uri.fsPath).toString('base64') };
    });
    this.view?.webview.postMessage({ type: 'attachedImages', images });
  }

  /* ------------------------------------------------------------------ state */

  private activeTask(): Task | undefined {
    return this.activeTaskId ? this.tasks.get(this.activeTaskId) : undefined;
  }

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.postState();
    }, 60);
  }

  private postState(): void {
    const cfg = this.config();
    const tasks = [...this.tasks.values()].map(t => ({
      id: t.id,
      name: t.name,
      cwd: t.cwd,
      alive: t.alive,
      streaming: t.conv.streaming,
      model: t.model,
      thinking: t.thinking,
      sessionFile: t.sessionFile,
      sessionId: t.sessionId,
      sessionName: t.sessionName,
      stats: t.stats,
      widgets: t.widgets,
      lastError: t.lastError,
      messages: t.conv.messages,
      changedFiles: t.conv.changedFiles,
      queue: t.conv.queue,
    }));
    this.persistTasks();
    const active = this.activeTask();
    if (active?.conv.streaming) {
      this.status.text = `$(sync~spin) pi: ${active.name}`;
      this.status.show();
    } else if (this.status.text.startsWith('$(sync~spin)')) {
      this.status.hide();
    }
    this.view?.webview.postMessage({
      type: 'state',
      activeTaskId: this.activeTaskId,
      tasks,
      settings: { sendOnEnter: cfg.get<boolean>('sendOnEnter', true), showThinking: cfg.get<boolean>('showThinking', true) },
    });
  }

  private report(err: any): void {
    this.output.appendLine(`error: ${err?.stack || err}`);
  }

  dispose(): void {
    for (const t of this.tasks.values()) t.proc?.kill();
    this.tasks.clear();
  }
}

function fmtDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PiCodeProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('piCode.chatView', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('piCode.newTask', () => provider.newTask()),
    vscode.commands.registerCommand('piCode.stopTask', () => provider.stopActive()),
    vscode.commands.registerCommand('piCode.restartTask', () => provider.restartActive()),
    vscode.commands.registerCommand('piCode.addSelection', () => provider.addSelection()),
    vscode.commands.registerCommand('piCode.addFile', (uri?: vscode.Uri) => provider.addFile(uri)),
    vscode.commands.registerCommand('piCode.resumeSession', () => provider.resumeSession()),
    vscode.commands.registerCommand('piCode.newSession', () => provider.newSessionInActive()),
    vscode.commands.registerCommand('piCode.compact', () => provider.compactActive()),
    vscode.commands.registerCommand('piCode.focus', () => provider.focus()),
    provider,
  );
}

export function deactivate(): void {}
