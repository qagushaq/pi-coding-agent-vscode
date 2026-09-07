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
  messageCount: number;
};

export function sessionsRoot(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

/** pi stores sessions under a directory named after the cwd with `/` replaced by `-` and wrapped in `--`. */
export function sessionDirFor(cwd: string): string {
  return path.join(sessionsRoot(), `--${cwd.replace(/[\\/]/g, '-').replace(/^-+/, '')}--`.replace(/^--+-/, '--'));
}

function candidateDirs(cwd: string): string[] {
  const dirs = new Set<string>();
  dirs.add(sessionDirFor(cwd));
  // Older/other encodings: try to match by reading the header instead of trusting the name.
  try {
    for (const entry of fs.readdirSync(sessionsRoot())) dirs.add(path.join(sessionsRoot(), entry));
  } catch {
    /* no sessions yet */
  }
  return [...dirs];
}

function readHeadLines(file: string, maxBytes = 64 * 1024): string[] {
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

function countMessages(file: string): number {
  try {
    const text = fs.readFileSync(file, 'utf8');
    let n = 0;
    for (const line of text.split('\n')) if (line.startsWith('{"type":"message"')) n++;
    return n;
  } catch {
    return 0;
  }
}

/** Parse enough of a session file to show it in a picker. Returns undefined for files that are not pi sessions. */
export function readSessionInfo(file: string): SessionInfo | undefined {
  const lines = readHeadLines(file);
  if (!lines.length) return undefined;
  let header: any;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return undefined;
  }
  if (header?.type !== 'session') return undefined;
  let name: string | undefined;
  let firstPrompt: string | undefined;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'session_info' || entry.type === 'session_name') name = entry.name || name;
    if (!firstPrompt && entry.type === 'message' && entry.message?.role === 'user') {
      const c = entry.message.content;
      firstPrompt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ') : '';
      firstPrompt = firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    if (name && firstPrompt) break;
  }
  const stat = fs.statSync(file);
  return {
    file,
    id: header.id,
    cwd: header.cwd,
    createdAt: new Date(header.timestamp || stat.birthtime),
    modifiedAt: stat.mtime,
    name,
    firstPrompt,
    messageCount: countMessages(file),
  };
}

/** Sessions recorded for a workspace folder, newest first. */
export function listSessions(cwd: string, limit = 50): SessionInfo[] {
  const out: SessionInfo[] = [];
  for (const dir of candidateDirs(cwd)) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const info = readSessionInfo(path.join(dir, f));
      if (info && info.cwd === cwd && info.messageCount > 0) out.push(info);
    }
  }
  out.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return out.slice(0, limit);
}
