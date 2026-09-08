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
- Up in an empty composer walks back through prompts already sent in this task, Down walks forward again; text you have not sent stays with its task when you switch tabs.

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
- Ctrl/Cmd+F searches the conversation in place, Enter and Shift+Enter step through the matches, Esc closes the bar.
- `Copy Last Answer` puts pi's own rendering of the last answer on the clipboard; `Show Logs` opens the Pi Code output channel.
- A "↓ Latest" button appears when you scroll away from the end while pi writes; finished answers have a copy button; the footer draws context usage as a meter.
- `Session Timeline…` lists the session as pi records it (prompts, answers, model and thinking-level changes, compactions) and rewinds to any prompt.
- `Next Model` / `Next Thinking Level` step through pi's own rings.
- A pi that exits on its own is started again on the same session file, up to three times in a row (`piCode.autoRestart`).

## Rewind and editor context

**Rewind.** Every message you sent carries a hover button that rewinds the conversation to just before it,
and `Pi Code: Rewind Conversation` offers the same points in a quick pick. pi has no undo command: a session
is a tree of entries, so this uses `fork` to move the leaf back to the parent of that message and puts the
prompt text back into the composer for editing. Files pi already wrote are not reverted - only the
conversation moves.

**Editor context.** Like Claude's extension, Pi Code tells the agent what you are looking at without you
attaching anything: the active file and cursor line, the selected text when there is a selection
(`piCode.autoContext`), and the errors and warnings VS Code reports for that file
(`piCode.shareDiagnostics`). A file you attached by hand is never repeated.

**Editor tab and status bar.** `Pi Code: Open Chat in Editor Tab` puts the same chat in a wide editor
column next to the code; the sidebar and the tab stay in sync and either one can drive the task. The status
bar keeps a readout of whether pi is idle, working or stopped, with the cost so far and the model, effort and
context usage in its tooltip; clicking it focuses the chat.

**Modes.** `Pi Code: Modes` toggles the four switches pi keeps for a session: auto compaction, auto retry,
and whether steering and follow-up messages are delivered one at a time or all at once. The extension pushes
the settings into every session it starts, so a session opened from the sidebar behaves like your terminal
pi. pi stores these globally, so a change here is visible to the CLI too.

**Branching.** A rewind does not throw the old line of work away: pi's `fork` continues in a fresh session
file, so the branch you left keeps its own entry in the sessions panel and can be reopened. `Pi Code: Branch
Session` does the same at the current point without dropping anything - useful for trying a second approach
while keeping the first.

**When pi finishes out of sight.** A task that settles while the chat is hidden puts a count on the Pi Code
icon, and `piCode.notifyWhenDone: notification` adds a notification with the first line of the answer and a
button that opens the task. Opening or focusing the chat clears the count.

**Terminal handoff.** `Pi Code: Continue Session in Terminal` opens the pi CLI on the same session file; the
extension stops its own pi for that task first, because two processes writing one session file would fight.
Restarting the task takes it back.

**Drag and drop.** Files and folders dragged from the explorer land in the composer: a folder becomes a
mention, an image becomes an attachment, anything else is attached as a context chip.

## Sessions and reasoning effort

**Sessions view.** The Pi Code container has a second view listing every pi session recorded for the
workspace, grouped by recency (Today / Yesterday / This week / This month / Older). Each row shows the
session name or its first prompt, age, message count and the model it last ran on; open sessions are marked,
and a running one spins. One click opens a session as a task, or focuses the task that already holds it.
The title bar has search, a workspace/all toggle, archived visibility and refresh; the row menu has rename,
archive, copy id, reveal file and delete. Archive and local renames are stored in the extension, never by
rewriting pi's session files; renaming a session that is currently open also sends `set_session_name` to pi
so the name lands in the file. The list refreshes itself as pi appends to sessions.

**Reasoning effort.** Gateways that put the effort into the model id (`gpt-6-astra-xhigh-fast`) leave pi's
own thinking selector inert, because effort is not a request parameter there. Pi Code parses the ids into
family, effort and speed and offers three controls: a model family dropdown, an effort ladder built from the
variants that actually exist for that family, and a `fast` toggle. Switching family keeps the effort where
possible and falls back to the nearest lower level when the new family has a shorter ladder, saying so in the
transcript. `Cmd/Ctrl+Alt+E` steps the effort one notch. Where a provider does support real thinking levels,
the native selector appears instead and `set_thinking_level` is used.

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
| `piCode.defaultModel` | `""` | Passed as `--model` for new tasks, e.g. `litellm/gpt-6-astra-max`. Empty uses pi's `defaultModel`. |
| `piCode.defaultThinkingLevel` | `""` | Applied to fresh sessions when the model reports reasoning support. |
| `piCode.extraArgs` | `[]` | Extra arguments for `pi --mode rpc`. |
| `piCode.sendOnEnter` | `true` | Enter sends, Shift+Enter inserts a newline. Off: Ctrl/Cmd+Enter sends. |
| `piCode.restoreTasks` | `true` | Reopen last tasks and their sessions per workspace. |
| `piCode.contextFileMaxKb` | `96` | Size limit for files inlined via `@mention` / Add File. |
| `piCode.showThinking` | `true` | Render thinking blocks. |
| `piCode.defaultEffort` | `""` | Reasoning effort for new tasks on gateways that encode it in the model id. |
| `piCode.preferFastVariants` | `false` | Prefer the `-fast` variant when switching family or effort. |
| `piCode.autoContext` | `"selection"` | What the active editor adds to every prompt: `off`, `file` (path and line) or `selection` (also inlines the selected text). |
| `piCode.shareDiagnostics` | `true` | Send the errors and warnings VS Code reports for the active file. |
| `piCode.notifyWhenDone` | `badge` | What to do when pi finishes while the chat is not visible: `off`, `badge`, `notification`. |
| `piCode.autoRestart` | `true` | Start pi again when it exits on its own (up to three times in a row). |
| `piCode.statusBar` | `true` | Keep a Pi Code readout in the status bar (state, cost, model and context in the tooltip). |
| `piCode.autoCompaction` | `true` | Let pi compact the conversation on its own when the context window fills up. |
| `piCode.autoRetry` | `true` | Let pi retry a request that failed on the provider side. |
| `piCode.steeringMode` | `one-at-a-time` | How steering messages sent while pi works are delivered. |
| `piCode.followUpMode` | `one-at-a-time` | How queued follow-up messages are delivered once pi stops. |

When a provider reports no thinking levels, the native selector is hidden and the family/effort controls take over; see the section above.

## Development

```bash
npm run compile          # tsc
npm run check            # tsc + model-tier parsing + sidebar render + editor context, all on stubs
node scripts/sessions-check.js  # session listing against the real ~/.pi store (read-only)
npm run smoke            # drives a real `pi --mode rpc` end to end (one small model call)
npm test                 # downloads VS Code and drives the extension in a real extension host
npm run package          # builds the .vsix
npm run install-local    # builds and installs it into your VS Code
```

The stub checks are fast but blind to VS Code itself: the fan-out recursion fixed in 0.5.3 passed every one
of them and still emptied the chat. `npm test` is the suite that sees that class of breakage, so run it
before shipping.

Layout: `src/pi-process.ts` (subprocess, JSONL framing, request/response correlation), `src/conversation.ts` (pure reducer from RPC events to UI messages, also rebuilds from `get_messages`), `src/sessions.ts` (session file discovery), `src/webview.ts` (sidebar HTML/CSS/JS with its own markdown renderer), `src/extension.ts` (VS Code glue: tasks, commands, editor context, extension UI bridging, diffs).

## License

MIT
