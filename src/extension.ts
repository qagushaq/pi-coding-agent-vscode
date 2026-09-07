import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PiProcess, RpcEvent, RpcResponse, augmentedEnv, resolvePiCommand } from './pi-process';
import { Conversation, UiImage, UiMessage, nextId } from './conversation';
import { deleteSession, listSessions, SessionInfo, sessionTitle } from './sessions';
import { SessionNode, SessionTreeProvider } from './session-tree';
import { Effort, Family, buildFamilies, composeModelId, familyLabel, parseModelId } from './model-tiers';
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
  families: Family[];
  tier: { family?: string; effort?: Effort; fast: boolean };
  levels: string[];
  commands: any[];
  currentBashId?: string;
  bashReqId?: string;
  modes?: PiModes;
};

/** The four pi runtime switches the extension mirrors from settings. */
type PiModes = { autoCompaction: boolean; autoRetry: boolean; steeringMode: string; followUpMode: string };

const QUEUE_MODES = ['one-at-a-time', 'all'];

type PersistedTask = { name: string; cwd: string; model?: string; sessionFile?: string; sessionId?: string; messages?: UiMessage[] };

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const TASKS_STATE_KEY = 'piCode.tasks';
const ACTIVE_TASK_STATE_KEY = 'piCode.activeTaskId';

export class PiCodeProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private tasks = new Map<string, Task>();
  private activeTaskId?: string;
  private restored = false;
  private status: vscode.StatusBarItem;
  private extStatus: vscode.StatusBarItem;
  private renderTimer?: NodeJS.Timeout;
  private output: vscode.OutputChannel;
  tree?: SessionTreeProvider;

  constructor(private context: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.name = 'Pi Code';
    this.status.command = 'piCode.focus';
    // pi's own extensions can push a status line of their own; it must not fight with ours.
    this.extStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
    this.extStatus.name = 'Pi Code (extension)';
    this.output = vscode.window.createOutputChannel('Pi Code');
    context.subscriptions.push(this.status, this.extStatus, this.output);
  }

  /* ------------------------------------------------------------------ webview */

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.wire(view.webview);
    view.onDidChangeVisibility(() => {
      if (view.visible) this.postState();
    });
  }

  /** The sidebar and the editor tab run the same page; whichever exists gets the same messages. */
  private wire(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    webview.html = renderWebviewHtml(webview.cspSource, nonce);
    webview.onDidReceiveMessage(msg => this.onWebviewMessage(msg).catch(err => this.report(err)));
  }

  private post(message: any): void {
    this.post(message);
    this.panel?.webview.postMessage(message);
  }

  /** Opens the chat as an editor tab, the way Claude's extension can, and keeps it in sync with the sidebar. */
  openInEditor(): void {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel('piCode.chatPanel', 'Pi Code', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.context.extensionUri],
    });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'pi-code.svg');
    this.panel = panel;
    this.wire(panel.webview);
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    panel.onDidChangeViewState(e => {
      if (e.webviewPanel.visible) this.postState();
    });
    this.postState();
    for (const t of this.tasks.values()) this.postTaskInfo(t);
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
      case 'rewind':
        await this.rewind(typeof msg.index === 'number' ? msg.index : undefined);
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
      case 'setTier':
        await this.setTier(msg);
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
      case 'dropUris':
        await this.dropUris(Array.isArray(msg.uris) ? msg.uris.map(String) : []);
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
      families: [],
      tier: { fast: false },
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
      await this.applyModes(task);
      await this.loadTaskInfo(task);
      const effort = cfg.get<string>('defaultEffort') as Effort | '' | undefined;
      if (opts.fresh && effort) await this.setTier({ effort, fast: cfg.get<boolean>('preferFastVariants', false) });
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
    if (d.model?.id) {
      task.model = `${d.model.provider ? d.model.provider + '/' : ''}${d.model.id}`;
      this.syncTier(task);
    }
    if (task.sessionName && task.name.startsWith('Task ')) task.name = task.sessionName;
    task.modes = {
      autoCompaction: d.autoCompactionEnabled !== false,
      autoRetry: task.modes?.autoRetry ?? this.config().get<boolean>('autoRetry', true),
      steeringMode: d.steeringMode || 'one-at-a-time',
      followUpMode: d.followUpMode || 'one-at-a-time',
    };
    const lv = await task.proc.request({ type: 'get_available_thinking_levels' });
    if (lv.success) task.levels = lv.data?.levels || [];
  }

  /** pi keeps these switches per session, so push the settings into every live task. */
  private async applyModes(task: Task): Promise<void> {
    if (!task.proc?.alive) return;
    const cfg = this.config();
    const want: PiModes = {
      autoCompaction: cfg.get<boolean>('autoCompaction', true),
      autoRetry: cfg.get<boolean>('autoRetry', true),
      steeringMode: cfg.get<string>('steeringMode') || 'one-at-a-time',
      followUpMode: cfg.get<string>('followUpMode') || 'one-at-a-time',
    };
    if (!QUEUE_MODES.includes(want.steeringMode)) want.steeringMode = 'one-at-a-time';
    if (!QUEUE_MODES.includes(want.followUpMode)) want.followUpMode = 'one-at-a-time';
    const have = task.modes;
    try {
      if (!have || have.autoCompaction !== want.autoCompaction)
        await task.proc.request({ type: 'set_auto_compaction', enabled: want.autoCompaction });
      if (!have || have.autoRetry !== want.autoRetry)
        await task.proc.request({ type: 'set_auto_retry', enabled: want.autoRetry });
      if (!have || have.steeringMode !== want.steeringMode)
        await task.proc.request({ type: 'set_steering_mode', mode: want.steeringMode });
      if (!have || have.followUpMode !== want.followUpMode)
        await task.proc.request({ type: 'set_follow_up_mode', mode: want.followUpMode });
    } catch (err: any) {
      this.output.appendLine(`[${task.name}] could not apply modes: ${err.message}`);
      return;
    }
    task.modes = want;
  }

  /** Re-push the switches to every live task; used when the settings change. */
  async applyModesToAll(): Promise<void> {
    for (const task of this.tasks.values()) await this.applyModes(task);
    this.postState();
  }

  /** A quick pick over the four switches; picking one writes the setting, which re-applies it. */
  async pickModes(): Promise<void> {
    const cfg = this.config();
    const auto = cfg.get<boolean>('autoCompaction', true);
    const retry = cfg.get<boolean>('autoRetry', true);
    const steer = cfg.get<string>('steeringMode') || 'one-at-a-time';
    const follow = cfg.get<string>('followUpMode') || 'one-at-a-time';
    const other = (m: string) => (m === 'all' ? 'one-at-a-time' : 'all');
    const items = [
      { label: `${auto ? '$(check)' : '$(circle-large-outline)'} Auto compaction`, description: auto ? 'on' : 'off', key: 'autoCompaction', value: !auto },
      { label: `${retry ? '$(check)' : '$(circle-large-outline)'} Auto retry`, description: retry ? 'on' : 'off', key: 'autoRetry', value: !retry },
      { label: '$(arrow-right) Steering mode', description: steer, detail: `Switch to '${other(steer)}'`, key: 'steeringMode', value: other(steer) },
      { label: '$(list-ordered) Follow-up mode', description: follow, detail: `Switch to '${other(follow)}'`, key: 'followUpMode', value: other(follow) },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Toggle a pi mode' });
    if (!pick) return;
    await cfg.update(pick.key, pick.value, vscode.ConfigurationTarget.Workspace);
    await this.applyModesToAll();
  }

  private async loadTaskInfo(task: Task): Promise<void> {
    if (!task.proc?.alive) return;
    const [models, commands] = await Promise.all([task.proc.request({ type: 'get_available_models' }), task.proc.request({ type: 'get_commands' })]);
    if (models.success) {
      task.models = models.data?.models || [];
      task.families = buildFamilies(task.models.map((m: any) => ({ id: m.id, provider: m.provider })));
    }
    if (commands.success) task.commands = commands.data?.commands || [];
    this.postTaskInfo(task);
  }

  private postTaskInfo(task: Task): void {
    this.post({
      type: 'modelOptions',
      taskId: task.id,
      families: task.families.map(f => ({ family: f.family, label: familyLabel(f.family), efforts: f.efforts, hasFast: f.hasFast, hasBase: f.hasBase })),
      levels: task.levels,
    });
    this.post({ type: 'commands', taskId: task.id, commands: task.commands.map(c => ({ name: c.name, description: c.description, source: c.source })) });
  }

  /** Keep `tier` in sync with whatever model id the session actually runs. */
  private syncTier(task: Task): void {
    const id = (task.model || '').replace(/^.*?\//, '');
    if (!id) return;
    const p = parseModelId(id);
    task.tier = { family: p.family, effort: p.effort, fast: p.fast };
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
          this.extStatus.text = `$(hubot) ${req.statusText}`;
          this.extStatus.show();
        } else {
          this.extStatus.hide();
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
        this.post({ type: 'setEditorText', text: req.text || '' });
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

  /**
   * What the editor is showing right now, in the shape Claude Code shares automatically: the active file,
   * the selection (or cursor line) and whatever the language servers are complaining about in that file.
   * Kept deliberately small - the file body is only inlined when the user selected part of it.
   */
  /** Continue in a copy of this session, leaving the current one on disk untouched. */
  async cloneSession(): Promise<void> {
    const task = this.activeTask();
    if (!task?.proc?.alive) return;
    if (task.conv.streaming) {
      vscode.window.showWarningMessage('Pi is still working. Stop it before branching.');
      return;
    }
    const r = await task.proc.request({ type: 'clone' });
    if (!r.success || r.data?.cancelled) {
      task.conv.system(r.error || 'Branching cancelled', 'warning');
      this.postState();
      return;
    }
    const previousFile = task.sessionFile;
    await this.refreshState(task);
    const msgs = await task.proc.request({ type: 'get_messages' });
    if (msgs.success) task.conv.load(msgs.data?.messages || []);
    task.conv.system(
      previousFile && previousFile !== task.sessionFile
        ? 'Branched into a copy of this session. The original stays in the sessions panel as it was.'
        : 'Branched this session.',
      'system',
    );
    await this.afterRun(task);
    this.focus();
  }

  private editorContext(cwd: string, alreadyAttached: string[]): string {
    const mode = this.config().get<string>('autoContext', 'selection');
    if (mode === 'off') return '';
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') return '';
    const abs = ed.document.uri.fsPath;
    if (alreadyAttached.includes(abs)) return '';
    const rel = abs.startsWith(cwd) ? path.relative(cwd, abs) : abs;
    const sel = ed.selection;
    const lines: string[] = [];
    if (!sel.isEmpty && mode === 'selection') {
      const body = ed.document.getText(sel);
      const max = (this.config().get<number>('contextFileMaxKb') || 96) * 1024;
      const fence = body.includes('```') ? '````' : '```';
      lines.push(`The user is looking at ${rel}:${sel.start.line + 1}-${sel.end.line + 1} and has this selected:`);
      lines.push(`${fence}${ed.document.languageId}\n${(body.length > max ? body.slice(0, max) + '\n[…truncated]' : body).replace(/\n$/, '')}\n${fence}`);
    } else {
      lines.push(`The user is looking at ${rel}:${sel.active.line + 1} (no selection).`);
    }
    if (this.config().get<boolean>('shareDiagnostics', true)) {
      const problems = vscode.languages
        .getDiagnostics(ed.document.uri)
        .filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
        .slice(0, 20)
        .map(d => `  ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'} ${d.source ? `[${d.source}] ` : ''}${d.message.replace(/\s+/g, ' ').slice(0, 200)}`);
      if (problems.length) lines.push(`Problems reported in ${rel}:\n${problems.join('\n')}`);
    }
    return lines.join('\n');
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
    parts.push(this.editorContext(cwd, chips.map(c => c.path)));
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
    if (texts.length) this.post({ type: 'restoreQueued', texts });
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
      this.syncTier(task);
      await this.refreshState(task);
      this.postTaskInfo(task);
    } else {
      task.conv.system(r.error || 'Could not switch model', 'error');
    }
    this.postState();
  }

  /**
   * Switch model family / effort / speed on gateways that encode effort in the model id.
   * Falls back to the nearest available effort when the target family has a shorter ladder.
   */
  async setTier(change: { family?: string; effort?: Effort; fast?: boolean }): Promise<void> {
    const task = this.activeTask();
    if (!task?.proc?.alive) return;
    const family = task.families.find(f => f.family === (change.family ?? task.tier.family));
    if (!family) {
      vscode.window.showWarningMessage('This provider does not expose model families with effort levels.');
      return;
    }
    const effort = change.effort ?? task.tier.effort;
    const fast = change.fast ?? task.tier.fast;
    const id = composeModelId(family, effort, fast);
    if (!id) {
      vscode.window.showWarningMessage(`No model id for ${family.family} at effort ${effort ?? 'default'}.`);
      return;
    }
    if (id === (task.model || '').replace(/^.*?\//, '')) {
      task.tier = { family: family.family, effort, fast };
      this.postState();
      return;
    }
    await this.setModel(`${task.models.find(m => m.id === id)?.provider || 'litellm'}/${id}`);
    const applied = parseModelId((task.model || '').replace(/^.*?\//, ''));
    if (applied.effort !== effort && effort) {
      task.conv.system(`${familyLabel(family.family)} has no "${effort}" level, using "${applied.effort ?? 'default'}".`, 'warning');
      this.postState();
    }
  }

  /** Step the effort one notch up, wrapping at the top of the ladder. */
  async cycleEffort(): Promise<void> {
    const task = this.activeTask();
    if (!task) return;
    const family = task.families.find(f => f.family === task.tier.family);
    if (!family?.efforts.length) {
      vscode.window.showInformationMessage('Current model has no effort levels to cycle.');
      return;
    }
    const idx = task.tier.effort ? family.efforts.indexOf(task.tier.effort) : -1;
    await this.setTier({ effort: family.efforts[(idx + 1) % family.efforts.length] });
  }

  /** Quick pick over family, then effort, then speed. */
  async pickModel(): Promise<void> {
    const task = this.activeTask();
    if (!task?.families.length) {
      vscode.window.showInformationMessage('Model list is not loaded yet.');
      return;
    }
    const fam = await vscode.window.showQuickPick(
      task.families.map(f => ({
        label: familyLabel(f.family),
        description: f.efforts.length ? f.efforts.join(' / ') : 'no effort levels',
        detail: f.family === task.tier.family ? 'current' : undefined,
        family: f,
      })),
      { title: 'Model family' },
    );
    if (!fam) return;
    let effort: Effort | undefined;
    if (fam.family.efforts.length) {
      const pick = await vscode.window.showQuickPick(
        fam.family.efforts.map(e => ({ label: e, description: e === task.tier.effort ? 'current' : undefined })),
        { title: `Reasoning effort for ${fam.label}` },
      );
      if (!pick) return;
      effort = pick.label as Effort;
    }
    let fast = task.tier.fast;
    if (fam.family.hasFast) {
      const pick = await vscode.window.showQuickPick(['standard', 'fast'], { title: 'Speed variant' });
      if (!pick) return;
      fast = pick === 'fast';
    }
    await this.setTier({ family: fam.family.family, effort, fast });
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

  /**
   * Rewinds the session to just before one of the user's own messages, the way Claude Code's rewind works.
   * pi has no dedicated undo: `fork` moves the session leaf to the parent of the chosen user entry and hands
   * the prompt text back, so we restore it into the composer for editing.
   */
  async rewind(userIndex?: number): Promise<void> {
    const task = this.activeTask();
    if (!task?.proc?.alive) return;
    if (task.conv.streaming) {
      vscode.window.showWarningMessage('Pi is still working. Stop it before rewinding.');
      return;
    }
    const list = await task.proc.request({ type: 'get_fork_messages' });
    if (!list.success) {
      task.conv.system(list.error || 'Could not read the rewind points', 'error');
      this.postState();
      return;
    }
    const points: { entryId: string; text: string }[] = list.data?.messages || [];
    if (!points.length) {
      vscode.window.showInformationMessage('Nothing to rewind to in this session yet.');
      return;
    }
    let target = typeof userIndex === 'number' ? points[userIndex] : undefined;
    if (!target) {
      const pick = await vscode.window.showQuickPick(
        points
          .map((p, i) => ({ label: `$(discard) ${p.text.replace(/\s+/g, ' ').trim().slice(0, 70) || '(empty prompt)'}`, description: `message ${i + 1} of ${points.length}`, p }))
          .reverse(),
        { title: 'Rewind to just before which message?', placeHolder: 'Everything after it is dropped from the conversation' },
      );
      target = pick?.p;
    }
    if (!target) return;
    const r = await task.proc.request({ type: 'fork', entryId: target.entryId });
    if (!r.success || r.data?.cancelled) {
      task.conv.system(r.error || 'Rewind cancelled', 'warning');
      this.postState();
      return;
    }
    const previousFile = task.sessionFile;
    // fork continues in a fresh session file, so the task has to follow it.
    await this.refreshState(task);
    const msgs = await task.proc.request({ type: 'get_messages' });
    if (msgs.success) task.conv.load(msgs.data?.messages || []);
    const kept = previousFile && previousFile !== task.sessionFile ? ' The branch you left is kept as its own session.' : '';
    task.conv.system(`Rewound to before that message. The prompt is back in the composer; the files pi already changed are untouched.${kept}`, 'system');
    this.post({ type: 'setEditorText', text: typeof r.data?.text === 'string' ? r.data.text : target.text });
    await this.afterRun(task);
    this.focus();
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

  /**
   * Hand the current session over to the pi CLI in a VS Code terminal. Two writers on one
   * session file would fight, so the extension's own pi is stopped first.
   */
  async openInTerminal(): Promise<void> {
    const task = this.activeTask();
    if (!task) return;
    if (!task.sessionFile) {
      vscode.window.showWarningMessage('This task has no session file yet. Send a prompt first.');
      return;
    }
    if (task.proc?.alive) {
      const go = await vscode.window.showWarningMessage(
        'Continue this session in a terminal? Pi Code will stop its own pi for this task so the two do not write the same session file.',
        { modal: true },
        'Continue in terminal',
      );
      if (go !== 'Continue in terminal') return;
      task.proc.kill();
      task.proc = undefined;
      task.alive = false;
      task.conv.markAborted();
      task.conv.system('Handed this session to a terminal. Restart the task to take it back.', 'system');
      this.postState();
    }
    const cfg = this.config();
    const command = resolvePiCommand(cfg.get<string>('piCommand'), augmentedEnv());
    const args = ['--session', task.sessionFile];
    if (task.model) args.push('--model', task.model);
    const terminal = vscode.window.createTerminal({ name: `pi: ${task.name}`, cwd: task.cwd });
    terminal.sendText([command, ...args].map(a => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' '));
    terminal.show();
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

  /** Open a session from the tree: focus its task when already open, otherwise start a task on it. */
  async openSessionFile(file: string, name?: string): Promise<void> {
    const existing = [...this.tasks.values()].find(t => t.sessionFile === file);
    if (existing) {
      this.activeTaskId = existing.id;
      await this.focus();
      this.postState();
      this.postTaskInfo(existing);
      return;
    }
    const info = listSessions(undefined, { limit: 5000 }).find(s => s.file === file);
    await this.focus();
    await this.newTask({ name: name || (info ? sessionTitle(info) : undefined), cwd: info?.cwd || this.workspaceCwd(), sessionFile: file });
  }

  /** A session file that vanished must not stay attached to a task. */
  detachSession(file: string): void {
    for (const t of this.tasks.values()) {
      if (t.sessionFile !== file) continue;
      t.proc?.kill();
      this.tasks.delete(t.id);
      if (this.activeTaskId === t.id) this.activeTaskId = [...this.tasks.keys()].pop();
    }
    this.postState();
  }

  /** Rename an open session through pi so the name lands in the session file too. */
  async renameOpenSession(file: string, name: string): Promise<boolean> {
    const task = [...this.tasks.values()].find(t => t.sessionFile === file);
    if (!task?.proc?.alive) return false;
    task.name = name;
    task.sessionName = name;
    task.proc.send({ type: 'set_session_name', name });
    this.postState();
    return true;
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
    this.post({ type: 'addContext', chip });
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
    this.post({ type: 'addContext', chip: { kind: 'file', path: target.fsPath, label: vscode.workspace.asRelativePath(target, false), text } });
  }

  /** Files dragged in from the explorer or Finder: pictures become image attachments, everything else context. */
  async dropUris(uris: string[]): Promise<void> {
    const images: { fileName: string; mimeType: string; data: string }[] = [];
    for (const raw of uris.slice(0, 20)) {
      let file: string;
      try {
        file = raw.startsWith('file:') ? vscode.Uri.parse(raw).fsPath : raw;
      } catch {
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        this.post({ type: 'insertMention', path: vscode.workspace.asRelativePath(vscode.Uri.file(file), false) });
        continue;
      }
      const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
      if (mime) images.push({ fileName: path.basename(file), mimeType: mime, data: fs.readFileSync(file).toString('base64') });
      else await this.addFile(vscode.Uri.file(file));
    }
    if (images.length) this.post({ type: 'attachedImages', images });
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
    this.post({ type: 'insertMention', path: pick.label, replaceFrom });
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
    // Whoever the user is actually looking at wins: an open editor tab should not yank the sidebar out.
    if (this.panel?.visible) this.panel.reveal(this.panel.viewColumn, false);
    else if (this.panel && !this.view) this.panel.reveal(this.panel.viewColumn, false);
    else await vscode.commands.executeCommand('piCode.chatView.focus');
    this.post({ type: 'focusInput' });
  }

  private async attachImage(): Promise<void> {
    const pick = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: true, filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] } });
    if (!pick?.length) return;
    const images = pick.map(uri => {
      const ext = path.extname(uri.fsPath).toLowerCase();
      const mimeType = IMAGE_TYPES[ext] || 'image/png';
      return { fileName: path.basename(uri.fsPath), mimeType, data: fs.readFileSync(uri.fsPath).toString('base64') };
    });
    this.post({ type: 'attachedImages', images });
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
      tier: t.tier,
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
    this.tree?.setOpen([...this.tasks.values()].filter(t => t.sessionFile).map(t => ({ file: t.sessionFile!, taskId: t.id, streaming: t.conv.streaming })));
    this.renderStatus();
    this.post({
      type: 'state',
      activeTaskId: this.activeTaskId,
      tasks,
      settings: { sendOnEnter: cfg.get<boolean>('sendOnEnter', true), showThinking: cfg.get<boolean>('showThinking', true) },
    });
  }

  /** A permanent readout of what pi is doing, the way Claude's extension keeps one in the status bar. */
  private renderStatus(): void {
    if (!this.config().get<boolean>('statusBar', true)) {
      this.status.hide();
      return;
    }
    const t = this.activeTask();
    if (!t) {
      this.status.hide();
      return;
    }
    const cost = typeof t.stats?.cost === 'number' && t.stats.cost > 0 ? ` $${t.stats.cost.toFixed(2)}` : '';
    const ctx = t.stats?.contextUsage?.percent;
    this.status.text = t.conv.streaming
      ? `$(sync~spin) Pi${cost}`
      : t.alive
        ? `$(hubot) Pi${cost}`
        : '$(debug-disconnect) Pi';
    const lines = [
      t.conv.streaming ? `Working on ${t.name}` : t.alive ? `Idle in ${t.name}` : `pi is not running in ${t.name}`,
      t.model ? `Model: ${t.model}${t.tier.effort ? ` (${t.tier.effort}${t.tier.fast ? ' fast' : ''})` : ''}` : '',
      typeof ctx === 'number' ? `Context: ${ctx}% of the window` : '',
      cost ? `Cost so far:${cost}` : '',
      'Click to focus the chat.',
    ].filter(Boolean);
    this.status.tooltip = lines.join('\n');
    this.status.backgroundColor = t.alive ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    this.status.show();
  }

  private report(err: any): void {
    this.output.appendLine(`error: ${err?.stack || err}`);
  }

  dispose(): void {
    this.panel?.dispose();
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
  const cwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const tree = new SessionTreeProvider(context, cwd);
  provider.tree = tree;
  const view = vscode.window.createTreeView('piCode.sessionsView', { treeDataProvider: tree, showCollapseAll: true });

  const refresh = () => {
    tree.refresh();
    view.description = [tree.scopeIsAll ? 'all workspaces' : path.basename(cwd()), tree.filterText ? `search: ${tree.filterText}` : ''].filter(Boolean).join(' · ');
  };
  refresh();
  void tree.prune();

  // pi appends to the session file on every turn, so watching the tree keeps ages and titles fresh.
  const watcher = fs.watch(require('./sessions').sessionsRoot(), { recursive: true }, () => {
    clearTimeout((watcher as any)._t);
    (watcher as any)._t = setTimeout(refresh, 1200);
  });

  const sessionOf = (node?: SessionNode): SessionInfo | undefined => (node && node.kind === 'session' ? node.session : undefined);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('piCode.chatView', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    view,
    { dispose: () => watcher.close() },
    vscode.commands.registerCommand('piCode.newTask', () => provider.newTask()),
    vscode.commands.registerCommand('piCode.stopTask', () => provider.stopActive()),
    vscode.commands.registerCommand('piCode.restartTask', () => provider.restartActive()),
    vscode.commands.registerCommand('piCode.addSelection', () => provider.addSelection()),
    vscode.commands.registerCommand('piCode.addFile', (uri?: vscode.Uri) => provider.addFile(uri)),
    vscode.commands.registerCommand('piCode.resumeSession', () => provider.resumeSession()),
    vscode.commands.registerCommand('piCode.newSession', () => provider.newSessionInActive()),
    vscode.commands.registerCommand('piCode.compact', () => provider.compactActive()),
    vscode.commands.registerCommand('piCode.rewind', () => provider.rewind()),
    vscode.commands.registerCommand('piCode.openInEditor', () => provider.openInEditor()),
    vscode.commands.registerCommand('piCode.modes', () => provider.pickModes()),
    vscode.commands.registerCommand('piCode.branchSession', () => provider.cloneSession()),
    vscode.commands.registerCommand('piCode.openInTerminal', () => provider.openInTerminal()),
    vscode.commands.registerCommand('piCode.exportHtml', () => provider.exportActiveHtml()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (['autoCompaction', 'autoRetry', 'steeringMode', 'followUpMode'].some(k => e.affectsConfiguration(`piCode.${k}`)))
        void provider.applyModesToAll();
    }),
    vscode.commands.registerCommand('piCode.focus', () => provider.focus()),
    vscode.commands.registerCommand('piCode.cycleEffort', () => provider.cycleEffort()),
    vscode.commands.registerCommand('piCode.pickModel', () => provider.pickModel()),

    vscode.commands.registerCommand('piCode.openSession', async (node?: SessionNode) => {
      const s = sessionOf(node);
      if (s) await provider.openSessionFile(s.file, tree.displayName(s));
    }),
    vscode.commands.registerCommand('piCode.refreshSessions', refresh),
    vscode.commands.registerCommand('piCode.searchSessions', async () => {
      const text = await vscode.window.showInputBox({ title: 'Search pi sessions', value: tree.filterText, prompt: 'Matches name, prompts, model and folder. Empty clears.' });
      if (text === undefined) return;
      tree.setFilter(text);
      refresh();
    }),
    vscode.commands.registerCommand('piCode.toggleSessionScope', () => {
      tree.toggleScope();
      refresh();
    }),
    vscode.commands.registerCommand('piCode.toggleArchived', () => {
      const on = tree.toggleArchived();
      vscode.window.setStatusBarMessage(on ? 'Pi Code: showing archived sessions' : 'Pi Code: archived sessions hidden', 2500);
    }),
    vscode.commands.registerCommand('piCode.renameSession', async (node?: SessionNode) => {
      const s = sessionOf(node);
      if (!s) return;
      const name = await vscode.window.showInputBox({ title: 'Rename session', value: tree.displayName(s) });
      if (name === undefined) return;
      const trimmed = name.trim();
      const wroteToPi = trimmed ? await provider.renameOpenSession(s.file, trimmed) : false;
      // Closed sessions keep the name locally; pi only accepts set_session_name on a running one.
      await tree.setName(s.file, wroteToPi ? undefined : trimmed || undefined);
      refresh();
    }),
    vscode.commands.registerCommand('piCode.archiveSession', async (node?: SessionNode) => {
      const s = sessionOf(node);
      if (s) await tree.setArchived(s.file, true);
    }),
    vscode.commands.registerCommand('piCode.unarchiveSession', async (node?: SessionNode) => {
      const s = sessionOf(node);
      if (s) await tree.setArchived(s.file, false);
    }),
    vscode.commands.registerCommand('piCode.deleteSession', async (node?: SessionNode) => {
      const s = sessionOf(node);
      if (!s) return;
      const ok = await vscode.window.showWarningMessage(`Delete session "${tree.displayName(s)}"? The file is removed from disk.`, { modal: true, detail: s.file }, 'Delete');
      if (ok !== 'Delete') return;
      provider.detachSession(s.file);
      try {
        deleteSession(s.file);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Could not delete: ${err.message}`);
      }
      await tree.setArchived(s.file, false);
      await tree.setName(s.file, undefined);
      refresh();
    }),
    vscode.commands.registerCommand('piCode.revealSession', async (node?: SessionNode) => {
      const s = sessionOf(node);
      if (s) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.file));
    }),
    vscode.commands.registerCommand('piCode.copySessionId', async (node?: SessionNode) => {
      const s = sessionOf(node);
      if (!s) return;
      await vscode.env.clipboard.writeText(s.id);
      vscode.window.showInformationMessage(`Session id copied: ${s.id}`);
    }),
    provider,
  );
}

export function deactivate(): void {}
