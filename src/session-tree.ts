import * as vscode from 'vscode';
import * as path from 'path';
import { BUCKET_ORDER, Bucket, SessionInfo, ageLabel, bucketOf, listSessions, sessionTitle } from './sessions';

const ARCHIVED_KEY = 'piCode.archivedSessions';
const NAMES_KEY = 'piCode.sessionNames';

export type SessionNode =
  | { kind: 'group'; label: string; sessions: SessionInfo[] }
  | { kind: 'session'; session: SessionInfo };

export type OpenState = { file: string; taskId: string; streaming: boolean }[];

/**
 * Sidebar list of pi sessions for the workspace, grouped by recency, so switching context is one click.
 * Open sessions are marked and sorted to the top of their group.
 */
export class SessionTreeProvider implements vscode.TreeDataProvider<SessionNode> {
  private emitter = new vscode.EventEmitter<SessionNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private sessions: SessionInfo[] = [];
  private open: OpenState = [];
  private filter = '';
  private scopeAll = false;
  private showArchived = false;

  constructor(private context: vscode.ExtensionContext, private cwd: () => string) {}

  refresh(): void {
    this.sessions = listSessions(this.scopeAll ? undefined : this.cwd());
    this.emitter.fire(undefined);
  }

  setOpen(open: OpenState): void {
    this.open = open;
    this.emitter.fire(undefined);
  }

  setFilter(text: string): void {
    this.filter = text.trim().toLowerCase();
    this.emitter.fire(undefined);
  }

  get filterText(): string {
    return this.filter;
  }

  toggleScope(): boolean {
    this.scopeAll = !this.scopeAll;
    this.refresh();
    return this.scopeAll;
  }

  toggleArchived(): boolean {
    this.showArchived = !this.showArchived;
    this.emitter.fire(undefined);
    return this.showArchived;
  }

  get scopeIsAll(): boolean {
    return this.scopeAll;
  }

  /* archiving and renaming are stored locally: pi has no such concept and we never rewrite its session files */

  private archived(): string[] {
    return this.context.globalState.get<string[]>(ARCHIVED_KEY, []);
  }

  isArchived(file: string): boolean {
    return this.archived().includes(file);
  }

  async setArchived(file: string, archived: boolean): Promise<void> {
    const list = new Set(this.archived());
    if (archived) list.add(file);
    else list.delete(file);
    await this.context.globalState.update(ARCHIVED_KEY, [...list]);
    this.emitter.fire(undefined);
  }

  private names(): Record<string, string> {
    return this.context.globalState.get<Record<string, string>>(NAMES_KEY, {});
  }

  displayName(s: SessionInfo): string {
    return this.names()[s.file] || sessionTitle(s);
  }

  async setName(file: string, name: string | undefined): Promise<void> {
    const map = { ...this.names() };
    if (name) map[file] = name;
    else delete map[file];
    await this.context.globalState.update(NAMES_KEY, map);
    this.emitter.fire(undefined);
  }

  /** Forget local names and archive flags for sessions whose files no longer exist. */
  async prune(): Promise<void> {
    const alive = new Set(listSessions(undefined, { limit: 5000 }).map(s => s.file));
    await this.context.globalState.update(ARCHIVED_KEY, this.archived().filter(f => alive.has(f)));
    const names = this.names();
    const kept: Record<string, string> = {};
    for (const [f, n] of Object.entries(names)) if (alive.has(f)) kept[f] = n;
    await this.context.globalState.update(NAMES_KEY, kept);
  }

  private visible(): SessionInfo[] {
    const archived = new Set(this.archived());
    return this.sessions.filter(s => {
      if (!this.showArchived && archived.has(s.file)) return false;
      if (!this.filter) return true;
      const hay = `${this.displayName(s)} ${s.firstPrompt || ''} ${s.lastPrompt || ''} ${s.model || ''} ${s.cwd}`.toLowerCase();
      return hay.includes(this.filter);
    });
  }

  getChildren(node?: SessionNode): SessionNode[] {
    if (!node) {
      const groups = new Map<Bucket, SessionInfo[]>();
      for (const s of this.visible()) {
        const b = bucketOf(s.modifiedAt);
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b)!.push(s);
      }
      const openFiles = new Set(this.open.map(o => o.file));
      const out: SessionNode[] = [];
      for (const b of BUCKET_ORDER) {
        const list = groups.get(b);
        if (!list?.length) continue;
        list.sort((a, c) => Number(openFiles.has(c.file)) - Number(openFiles.has(a.file)) || c.modifiedAt.getTime() - a.modifiedAt.getTime());
        out.push({ kind: 'group', label: b, sessions: list });
      }
      return out;
    }
    return node.kind === 'group' ? node.sessions.map(session => ({ kind: 'session', session })) : [];
  }

  getTreeItem(node: SessionNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(node.sessions.length);
      item.contextValue = 'piGroup';
      return item;
    }
    const s = node.session;
    const openEntry = this.open.find(o => o.file === s.file);
    const item = new vscode.TreeItem(this.displayName(s), vscode.TreeItemCollapsibleState.None);
    const bits = [ageLabel(s.modifiedAt), `${s.messageCount} msg`];
    if (s.model) bits.push(s.model.replace(/^.*\//, ''));
    if (this.scopeAll) bits.push(path.basename(s.cwd));
    item.description = bits.join(' · ');
    item.tooltip = new vscode.MarkdownString(
      [
        `**${this.displayName(s)}**`,
        '',
        s.firstPrompt ? `${s.firstPrompt}` : '',
        '',
        `- session \`${s.id.slice(0, 8)}\``,
        `- ${s.messageCount} messages, ${(s.sizeBytes / 1024).toFixed(0)} KB`,
        s.model ? `- model \`${s.model}\`` : '',
        `- ${s.cwd}`,
        `- ${s.modifiedAt.toLocaleString()}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    item.iconPath = new vscode.ThemeIcon(
      openEntry ? (openEntry.streaming ? 'loading~spin' : 'circle-filled') : this.isArchived(s.file) ? 'archive' : 'comment-discussion',
      openEntry && !openEntry.streaming ? new vscode.ThemeColor('charts.green') : undefined,
    );
    item.contextValue = openEntry ? 'piSessionOpen' : this.isArchived(s.file) ? 'piSessionArchived' : 'piSession';
    item.command = { command: 'piCode.openSession', title: 'Open', arguments: [node] };
    return item;
  }
}
