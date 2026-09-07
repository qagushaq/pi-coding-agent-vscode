import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type SessionInfo = {
  file: string;
  id: string;
  cwd: string;
  createdAt: Date;
  modifiedAt: Date;
  name?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  model?: string;
  messageCount: number;
  sizeBytes: number;
};

export function sessionsRoot(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

/** pi stores sessions under a directory named after the cwd with `/` replaced by `-` and wrapped in `--`. */
export function sessionDirFor(cwd: string): string {
  return path.join(sessionsRoot(), `--${cwd.replace(/[\\/]/g, '-').replace(/^-+/, '')}--`);
}

function allDirs(): string[] {
  try {
    return fs.readdirSync(sessionsRoot()).map(e => path.join(sessionsRoot(), e));
  } catch {
    return [];
  }
}

function readHeadLines(file: string, maxBytes = 128 * 1024): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, read).split('\n');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function promptText(entry: any): string {
  const c = entry?.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(' ') : '';
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse a pi session file into a listing entry. Reads the whole file only when it is small enough;
 * for large ones it scans the head for identity and counts messages by line prefix.
 */
export function readSessionInfo(file: string): SessionInfo | undefined {
  const head = readHeadLines(file);
  if (!head.length) return undefined;
  let header: any;
  try {
    header = JSON.parse(head[0]);
  } catch {
    return undefined;
  }
  if (header?.type !== 'session') return undefined;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }

  let name: string | undefined;
  let model: string | undefined;
  let firstPrompt: string | undefined;
  let lastPrompt: string | undefined;
  let messageCount = 0;

  let lines = head;
  if (stat.size <= 4 * 1024 * 1024) {
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      /* keep the head */
    }
  }

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('{"type":"message"')) messageCount++;
    // Only these entry kinds carry what the listing shows, so parse selectively.
    if (!/^\{"type":"(message|model_change|session_name|session_info)"/.test(line)) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'model_change' && entry.modelId) model = entry.modelId;
    if ((entry.type === 'session_name' || entry.type === 'session_info') && entry.name) name = entry.name;
    if (entry.type === 'message' && entry.message?.role === 'user') {
      const t = promptText(entry);
      if (t) {
        if (!firstPrompt) firstPrompt = t.slice(0, 200);
        lastPrompt = t.slice(0, 200);
      }
    }
  }

  return {
    file,
    id: header.id,
    cwd: header.cwd,
    createdAt: new Date(header.timestamp || stat.birthtime),
    modifiedAt: stat.mtime,
    name,
    firstPrompt,
    lastPrompt,
    model,
    messageCount,
    sizeBytes: stat.size,
  };
}

/**
 * Sessions on disk, newest first. Pass a cwd to keep only that workspace's sessions;
 * pass undefined to list every workspace.
 */
export function listSessions(cwd?: string, opts: { limit?: number; includeEmpty?: boolean } = {}): SessionInfo[] {
  const { limit = 300, includeEmpty = false } = opts;
  const dirs = cwd ? [sessionDirFor(cwd), ...allDirs()] : allDirs();
  const seen = new Set<string>();
  const out: SessionInfo[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      if (seen.has(full)) continue;
      seen.add(full);
      const info = readSessionInfo(full);
      if (!info) continue;
      if (cwd && info.cwd !== cwd) continue;
      if (!includeEmpty && info.messageCount === 0) continue;
      out.push(info);
    }
  }
  out.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return out.slice(0, limit);
}

export type Bucket = 'Today' | 'Yesterday' | 'This week' | 'This month' | 'Older';

export function bucketOf(d: Date, now = new Date()): Bucket {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - 86400000) return 'Yesterday';
  if (t >= startOfToday - 7 * 86400000) return 'This week';
  if (t >= startOfToday - 30 * 86400000) return 'This month';
  return 'Older';
}

export const BUCKET_ORDER: Bucket[] = ['Today', 'Yesterday', 'This week', 'This month', 'Older'];

/** Compact age label: 8m, 3h, 2d, 5w. */
export function ageLabel(d: Date, now = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/** Best display title for a session: explicit name, else its first prompt, else the file name. */
export function sessionTitle(s: SessionInfo): string {
  return (s.name || s.firstPrompt || path.basename(s.file).replace(/\.jsonl$/, '')).slice(0, 90);
}

export function deleteSession(file: string): void {
  fs.unlinkSync(file);
}
