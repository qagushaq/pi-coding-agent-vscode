# Pi Code for VS Code

**Language / Язык:** English | [Русский](README.ru.md)

A VS Code client for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). It talks to `pi --mode rpc` over stdin/stdout and gives you a sidebar chat with the things you expect from an IDE agent: streamed answers with markdown, collapsible thinking, tool calls with inline diffs, editor context, sessions, queueing and cost tracking.

Requires pi ≥ 0.84 (the RPC protocol with `agent_settled`, `get_entries` and the extension UI sub-protocol).

## Features

**Chat**
- Streaming markdown answers (headings, lists, tables, fenced code with copy button, links).
- Thinking blocks shown collapsed when the model streams reasoning (`piCode.showThinking`).
- Model and thinking-level selectors fed by pi's own config; changes apply to the running session.
- Errors from the model (401, 403, overload) are shown on the message, transient errors show pi's auto-retry progress.

**Tools**
- Every tool call is a collapsible card: `bash` shows the command and streamed output, `edit` shows a red/green diff of the change, `write` shows the file content, `read` the path.
- Paths in cards open the file; edit/write cards and the "Changed files" bar offer a diff of the working tree against git HEAD.
- Extension UI requests from pi (`select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`) are mapped to VS Code quick picks, modal dialogs, input boxes, notifications, the status bar and a widget strip above the composer.

**Editor context**
- `Pi Code: Add Selection to Pi Chat` (Cmd/Ctrl+Alt+L, editor context menu) attaches the selection with file path and line numbers; with no selection it attaches the whole file.
- `@` in the composer opens a workspace file picker; `@relative/path` typed by hand is inlined too (size limit `piCode.contextFileMaxKb`, larger files are referenced by path for pi's `read` tool).
- `Add File to Pi Chat` in the Explorer context menu.
- Images: attach, paste or drop into the composer.

**Control while pi is working**
- Enter while the agent runs sends a *steer* message (delivered after the current tool calls); the *Queue* button sends a follow-up delivered when the agent finishes.
- *Stop* (or Esc in the composer) clears the queue, aborts the run and puts queued text back into the composer.
- `!command` runs a shell command through pi and adds its output to the context for the next prompt.
- `/` lists pi's extension commands, prompt templates and skills.

**Sessions**
- Several tasks as tabs, each its own pi process and session file.
- Tasks are restored when VS Code reopens the workspace; history is reloaded from the pi session, so nothing depends on webview state.
- `Resume Session…` lists pi sessions recorded for this workspace (name, first prompt, message count, last modified).
- Rename (also sets pi's session name), new session in the same task, compact context, export to HTML, copy session path, restart the pi process.
- Footer shows session, model, thinking level, context usage, token counts and cost after each run.

## Install

Build from source (needs Node ≥ 18 and the `code` CLI):

```bash
npm install
npm run install-local     # compile, package, install into VS Code
```

Then run `Developer: Reload Window`. The Pi Code icon appears in the activity bar.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `piCode.piCommand` | `""` | Path to `pi`. Empty searches PATH plus `/usr/local/bin`, `/opt/homebrew/bin` and nvm installs, so a wrapper script in `/usr/local/bin` is found even when the extension host has a bare PATH. |
| `piCode.defaultModel` | `""` | Passed as `--model` for new tasks, e.g. `litellm/claude-opus-4-8`. Empty uses pi's `defaultModel`. |
| `piCode.defaultThinkingLevel` | `""` | Applied to fresh sessions when the model reports reasoning support. |
| `piCode.extraArgs` | `[]` | Extra arguments for `pi --mode rpc`. |
| `piCode.sendOnEnter` | `true` | Enter sends, Shift+Enter inserts a newline. Off: Ctrl/Cmd+Enter sends. |
| `piCode.restoreTasks` | `true` | Reopen last tasks and their sessions per workspace. |
| `piCode.contextFileMaxKb` | `96` | Size limit for files inlined via `@mention` / Add File. |
| `piCode.showThinking` | `true` | Render thinking blocks. |

A model shows `No thinking` when pi's `models.json` has `reasoning: false` for it; that is pi's configuration, not the extension's.

## Development

```bash
npm run compile          # tsc
node scripts/webview-check.js   # renders the sidebar in a DOM stub, checks markdown/diff/escaping
npm run smoke            # drives a real `pi --mode rpc` end to end (one small model call)
npm run package          # builds the .vsix
```

Layout: `src/pi-process.ts` (subprocess, JSONL framing, request/response correlation), `src/conversation.ts` (pure reducer from RPC events to UI messages, also rebuilds from `get_messages`), `src/sessions.ts` (session file discovery), `src/webview.ts` (sidebar HTML/CSS/JS with its own markdown renderer), `src/extension.ts` (VS Code glue: tasks, commands, editor context, extension UI bridging, diffs).

## License

MIT
