import * as path from 'path';
import type { RpcEvent } from './pi-process';

export type UiImage = { mimeType: string; data: string; fileName?: string };

export type UiMessage =
  | { id: string; role: 'user'; text: string; images?: UiImage[] }
  | { id: string; role: 'assistant'; text: string; thinking: string; status: 'streaming' | 'done' | 'error' | 'aborted'; error?: string; model?: string }
  | { id: string; role: 'tool'; toolName: string; args: any; argsText?: string; output: string; status: 'running' | 'done' | 'error'; path?: string }
  | { id: string; role: 'bash'; command: string; output: string; exitCode?: number | null; status: 'running' | 'done' | 'error' }
  | { id: string; role: 'system' | 'error' | 'warning' | 'compaction'; text: string };

export type ConversationSnapshot = {
  messages: UiMessage[];
  streaming: boolean;
  changedFiles: string[];
  queue: { steering: string[]; followUp: string[] };
};

const FILE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'create', 'patch']);
const MAX_TOOL_OUTPUT = 20000;

let counter = 0;
export function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(++counter).toString(36)}`;
}

/** Turns a tool result / partial result into displayable text. */
export function extractToolText(result: any): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : JSON.stringify(c)))
      .join('\n');
  }
  if (typeof content === 'string') return content;
  return JSON.stringify(result, null, 2);
}

function clip(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n… [${text.length - MAX_TOOL_OUTPUT} more characters truncated in the panel]`;
}

function toolPath(args: any): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  return args.path || args.file_path || args.filePath || args.file || undefined;
}

function userText(content: any): { text: string; images: UiImage[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  const images = content.filter((c: any) => c.type === 'image' && c.data).map((c: any) => ({ mimeType: c.mimeType || 'image/png', data: c.data }));
  return { text, images };
}

/**
 * Pure reducer that turns pi RPC events (or a loaded AgentMessage history) into a flat list of UI messages.
 * Keeps no vscode dependency so it can be exercised from plain node.
 */
export class Conversation {
  messages: UiMessage[] = [];
  streaming = false;
  changedFiles: string[] = [];
  queue = { steering: [] as string[], followUp: [] as string[] };
  private currentAssistant?: Extract<UiMessage, { role: 'assistant' }>;
  private toolArgBuffers = new Map<string, string>();

  constructor(readonly cwd: string) {}

  snapshot(): ConversationSnapshot {
    return { messages: this.messages, streaming: this.streaming, changedFiles: this.changedFiles, queue: this.queue };
  }

  system(text: string, role: 'system' | 'error' | 'warning' | 'compaction' = 'system'): void {
    this.messages.push({ id: nextId(role), role, text });
  }

  addUser(text: string, images: UiImage[] = []): void {
    this.messages.push({ id: nextId('u'), role: 'user', text, images: images.length ? images : undefined });
  }

  addBash(command: string): string {
    const id = nextId('bash');
    this.messages.push({ id, role: 'bash', command, output: '', status: 'running' });
    return id;
  }

  finishBash(id: string, output: string, exitCode: number | null | undefined, isError: boolean): void {
    const msg = this.messages.find(m => m.id === id);
    if (msg?.role === 'bash') {
      msg.output = clip(output);
      msg.exitCode = exitCode;
      msg.status = isError ? 'error' : 'done';
    }
  }

  appendBash(id: string, delta: string): void {
    const msg = this.messages.find(m => m.id === id);
    if (msg?.role === 'bash') msg.output = clip(msg.output + delta);
  }

  /** Replace the history with what pi reports for the loaded session. */
  load(agentMessages: any[]): void {
    this.messages = [];
    this.currentAssistant = undefined;
    this.toolArgBuffers.clear();
    this.changedFiles = [];
    for (const m of agentMessages || []) {
      switch (m.role) {
        case 'user': {
          const { text, images } = userText(m.content);
          if (text || images.length) this.messages.push({ id: nextId('u'), role: 'user', text, images: images.length ? images : undefined });
          break;
        }
        case 'assistant': {
          const blocks = Array.isArray(m.content) ? m.content : [];
          const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
          const thinking = blocks.filter((b: any) => b.type === 'thinking').map((b: any) => b.thinking).join('\n');
          const status = m.stopReason === 'error' ? 'error' : m.stopReason === 'aborted' ? 'aborted' : 'done';
          if (text || thinking || m.errorMessage) {
            this.messages.push({ id: nextId('a'), role: 'assistant', text, thinking, status, error: m.errorMessage, model: m.model });
          }
          for (const call of blocks.filter((b: any) => b.type === 'toolCall')) {
            this.messages.push({ id: call.id || nextId('tool'), role: 'tool', toolName: call.name, args: call.arguments, output: '', status: 'done', path: toolPath(call.arguments) });
          }
          break;
        }
        case 'toolResult': {
          const tool = this.findTool(m.toolCallId);
          if (tool) {
            tool.output = clip(extractToolText(m));
            tool.status = m.isError ? 'error' : 'done';
            this.trackChange(tool);
          }
          break;
        }
        case 'bashExecution':
          this.messages.push({ id: nextId('bash'), role: 'bash', command: m.command, output: clip(m.output || ''), exitCode: m.exitCode, status: m.exitCode === 0 || m.exitCode == null ? 'done' : 'error' });
          break;
        default:
          break;
      }
    }
  }

  /** Apply one streamed RPC event. Returns true when the UI should re-render. */
  apply(event: RpcEvent): boolean {
    switch (event.type) {
      case 'agent_start':
        this.streaming = true;
        return true;
      case 'agent_end':
        return false;
      case 'agent_settled':
        this.streaming = false;
        this.closeAssistant('done');
        this.finishRunningTools();
        return true;
      case 'message_start':
        if (event.message?.role === 'assistant') {
          const msg: Extract<UiMessage, { role: 'assistant' }> = { id: nextId('a'), role: 'assistant', text: '', thinking: '', status: 'streaming', model: event.message.model };
          this.messages.push(msg);
          this.currentAssistant = msg;
          return true;
        }
        return false;
      case 'message_update':
        return this.applyDelta(event.assistantMessageEvent);
      case 'message_end':
        return this.applyMessageEnd(event.message);
      case 'tool_execution_start': {
        let tool = this.findTool(event.toolCallId);
        if (!tool) {
          tool = { id: event.toolCallId || nextId('tool'), role: 'tool', toolName: event.toolName, args: event.args, output: '', status: 'running' };
          this.messages.push(tool);
        }
        tool.toolName = event.toolName || tool.toolName;
        tool.args = event.args ?? tool.args;
        tool.argsText = undefined;
        tool.path = toolPath(tool.args);
        tool.status = 'running';
        return true;
      }
      case 'tool_execution_update': {
        const tool = this.findTool(event.toolCallId);
        if (tool) tool.output = clip(extractToolText(event.partialResult));
        return !!tool;
      }
      case 'tool_execution_end': {
        const tool = this.findTool(event.toolCallId);
        if (tool) {
          tool.output = clip(extractToolText(event.result));
          tool.status = event.isError ? 'error' : 'done';
          this.trackChange(tool);
        }
        return !!tool;
      }
      case 'queue_update':
        this.queue = { steering: event.steering || [], followUp: event.followUp || [] };
        return true;
      case 'compaction_start':
        this.system(`Compacting context (${event.reason})…`, 'compaction');
        return true;
      case 'compaction_end':
        if (event.aborted) this.system('Compaction aborted', 'compaction');
        else if (event.errorMessage) this.system(`Compaction failed: ${event.errorMessage}`, 'error');
        else if (event.result) this.system(`Context compacted: ${fmtTokens(event.result.tokensBefore)} → ~${fmtTokens(event.result.estimatedTokensAfter)} tokens`, 'compaction');
        return true;
      case 'auto_retry_start':
        this.system(`Transient error, retry ${event.attempt}/${event.maxAttempts} in ${Math.round((event.delayMs || 0) / 1000)}s: ${event.errorMessage || ''}`, 'warning');
        return true;
      case 'auto_retry_end':
        if (!event.success) this.system(`Retries exhausted: ${event.finalError || ''}`, 'error');
        return !event.success;
      case 'extension_error':
        this.system(`Extension error (${path.basename(event.extensionPath || '')}, ${event.event}): ${event.error}`, 'error');
        return true;
      case 'client_error':
        this.system(event.error, 'error');
        return true;
      default:
        return false;
    }
  }

  private applyDelta(delta: any): boolean {
    if (!delta) return false;
    const cur = this.currentAssistant || this.ensureAssistant();
    switch (delta.type) {
      case 'text_delta':
        cur.text += delta.delta || '';
        return true;
      case 'thinking_delta':
        cur.thinking += delta.delta || '';
        return true;
      case 'toolcall_start': {
        const id = delta.id || delta.toolCall?.id || nextId('tool');
        if (!this.findTool(id)) {
          this.messages.push({ id, role: 'tool', toolName: delta.toolName || delta.toolCall?.name || 'tool', args: undefined, argsText: '', output: '', status: 'running' });
          this.toolArgBuffers.set(id, '');
        }
        return true;
      }
      case 'toolcall_delta': {
        const id = delta.id || delta.toolCall?.id;
        if (id && this.toolArgBuffers.has(id)) {
          const buf = this.toolArgBuffers.get(id)! + (delta.delta || '');
          this.toolArgBuffers.set(id, buf);
          const tool = this.findTool(id);
          if (tool) tool.argsText = buf;
        }
        return false;
      }
      case 'toolcall_end': {
        const call = delta.toolCall;
        const tool = this.findTool(call?.id || delta.id);
        if (tool && call) {
          tool.args = call.arguments;
          tool.toolName = call.name || tool.toolName;
          tool.argsText = undefined;
          tool.path = toolPath(call.arguments);
        }
        return true;
      }
      default:
        return false;
    }
  }

  private applyMessageEnd(message: any): boolean {
    if (!message) return false;
    if (message.role === 'assistant') {
      const cur = this.currentAssistant || this.ensureAssistant();
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      const thinking = blocks.filter((b: any) => b.type === 'thinking').map((b: any) => b.thinking).join('\n');
      if (text) cur.text = text;
      if (thinking) cur.thinking = thinking;
      cur.model = message.model || cur.model;
      if (message.stopReason === 'error') {
        cur.status = 'error';
        cur.error = message.errorMessage || 'Model call failed';
      } else if (message.stopReason === 'aborted') {
        cur.status = 'aborted';
      } else {
        cur.status = 'done';
      }
      this.currentAssistant = undefined;
      this.dropIfEmpty(cur);
      return true;
    }
    if (message.role === 'toolResult') {
      const tool = this.findTool(message.toolCallId);
      if (tool && tool.status === 'running') {
        tool.output = clip(extractToolText(message));
        tool.status = message.isError ? 'error' : 'done';
        this.trackChange(tool);
        return true;
      }
    }
    return false;
  }

  private ensureAssistant(): Extract<UiMessage, { role: 'assistant' }> {
    const msg: Extract<UiMessage, { role: 'assistant' }> = { id: nextId('a'), role: 'assistant', text: '', thinking: '', status: 'streaming' };
    this.messages.push(msg);
    this.currentAssistant = msg;
    return msg;
  }

  private closeAssistant(status: 'done' | 'aborted'): void {
    for (const m of [...this.messages]) {
      if (m.role === 'assistant' && m.status === 'streaming') {
        m.status = status;
        this.dropIfEmpty(m);
      }
    }
    this.currentAssistant = undefined;
  }

  /** A turn that only carried tool calls leaves an assistant bubble with nothing to show; remove it. */
  private dropIfEmpty(msg: Extract<UiMessage, { role: 'assistant' }>): void {
    if (msg.text || msg.thinking || msg.error || msg.status === 'aborted') return;
    const idx = this.messages.indexOf(msg);
    if (idx >= 0) this.messages.splice(idx, 1);
  }

  private finishRunningTools(): void {
    for (const m of this.messages) if (m.role === 'tool' && m.status === 'running') m.status = 'done';
  }

  markAborted(): void {
    this.streaming = false;
    this.closeAssistant('aborted');
    this.finishRunningTools();
  }

  private findTool(id: string | undefined): Extract<UiMessage, { role: 'tool' }> | undefined {
    if (!id) return undefined;
    const msg = this.messages.find(m => m.id === id);
    return msg && msg.role === 'tool' ? msg : undefined;
  }

  private trackChange(tool: Extract<UiMessage, { role: 'tool' }>): void {
    if (tool.status !== 'done' || !FILE_TOOLS.has(tool.toolName) || !tool.path) return;
    const abs = path.isAbsolute(tool.path) ? tool.path : path.join(this.cwd, tool.path);
    if (!this.changedFiles.includes(abs)) this.changedFiles.push(abs);
  }
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '?';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}
