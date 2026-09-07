import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type RpcCommand = { type: string; id?: string; [key: string]: unknown };
export type RpcResponse = { type: 'response'; id?: string; command: string; success: boolean; data?: any; error?: string };
export type RpcEvent = { type: string; [key: string]: any };

export type PiProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

const EXTRA_BIN_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), 'bin')];

function nvmBinDirs(): string[] {
  const root = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    return fs
      .readdirSync(root)
      .sort()
      .reverse()
      .map(v => path.join(root, v, 'bin'));
  } catch {
    return [];
  }
}

/** Build a PATH that also covers the places where `pi` usually lives when the extension host has a bare environment. */
export function augmentedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const current = (base.PATH || '').split(path.delimiter).filter(Boolean);
  const extra = [...EXTRA_BIN_DIRS, ...nvmBinDirs()].filter(d => !current.includes(d) && fs.existsSync(d));
  return { ...base, PATH: [...current, ...extra].join(path.delimiter) };
}

/** Resolve the configured pi command to an executable path. Returns the input unchanged when nothing better is found. */
export function resolvePiCommand(configured: string | undefined, env: NodeJS.ProcessEnv = augmentedEnv()): string {
  const name = (configured || '').trim() || 'pi';
  if (name.includes(path.sep) || name.includes('/')) {
    const expanded = name.startsWith('~') ? path.join(os.homedir(), name.slice(1)) : name;
    return expanded;
  }
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return name;
}

/**
 * One `pi --mode rpc` subprocess. Commands go to stdin as JSONL, events and responses come back on stdout.
 * Responses are correlated to requests by id; everything else is emitted as `event`.
 */
export class PiProcess extends EventEmitter {
  readonly proc: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
  private exited = false;

  constructor(readonly options: PiProcessOptions) {
    super();
    this.proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env || augmentedEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.attach();
  }

  get alive(): boolean {
    return !this.exited && this.proc.stdin.writable;
  }

  /** Fire-and-forget command (no response tracking). */
  send(command: RpcCommand): void {
    if (!this.alive) return;
    this.proc.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** Send a command and resolve with its response. */
  request(command: RpcCommand): Promise<RpcResponse> {
    if (!this.alive) return Promise.reject(new Error('pi process is not running'));
    const id = command.id || `req-${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  /** Answer a blocking extension UI request. */
  respondUi(id: string, payload: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    this.send({ type: 'extension_ui_response', id, ...payload });
  }

  kill(): void {
    if (this.exited) return;
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }

  private attach(): void {
    attachJsonlReader(this.proc.stdout, line => this.onLine(line));
    this.proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      if (text.trim()) this.emit('stderr', text);
    });
    this.proc.on('error', err => {
      this.exited = true;
      this.failPending(err);
      this.emit('error', err);
    });
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      this.failPending(new Error(`pi exited (${code ?? signal ?? 'unknown'})`));
      this.emit('exit', code, signal);
    });
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch (e: any) {
      this.emit('event', { type: 'client_error', error: `Bad JSON from pi: ${e.message}`, line });
      return;
    }
    if (parsed.type === 'response' && parsed.id && this.pending.has(parsed.id)) {
      const waiter = this.pending.get(parsed.id)!;
      this.pending.delete(parsed.id);
      waiter.resolve(parsed as RpcResponse);
      return;
    }
    this.emit('event', parsed as RpcEvent);
  }

  private failPending(err: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }
}

/** JSONL reader that splits on LF only, as the pi RPC protocol requires (Node readline also splits on U+2028/2029). */
export function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) break;
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      onLine(line);
    }
  });
  stream.on('end', () => {
    buffer += decoder.end();
    if (buffer.length) onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    buffer = '';
  });
}
