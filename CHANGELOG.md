# Changelog

## 0.5.1

- The packaged extension no longer ships sources and scripts (56 KB instead of 122 KB).
- A GitHub Actions run type-checks, runs the DOM and context checks and packages the vsix on every push.

## 0.5.0

- Files and folders dragged from the explorer land in the composer: a folder becomes a mention, an image an
  attachment, anything else a context chip.
- `Pi Code: Modes` and four settings mirror pi's own switches into every session the extension starts:
  auto compaction, auto retry, and whether steering and follow-up messages arrive one at a time or all at once.
- A rewind now follows pi into the fresh session file `fork` creates, so the task and the sessions panel stay
  in step and the branch you left stays openable.
- `Pi Code: Branch Session` continues in a copy of the current session, leaving the original untouched.
- `Pi Code: Continue Session in Terminal` hands the session to the pi CLI, stopping the extension's own pi
  first so the two never write the same file.
- `Pi Code: Export Conversation to HTML` is reachable from the command palette, not just the chat header.

## 0.4.0

- Rewind the conversation from a hover button on any of your messages, or from `Pi Code: Rewind Conversation`.
- The active file, the cursor line, the selection and the problems VS Code reports for that file are sent with
  every prompt (`piCode.autoContext`, `piCode.shareDiagnostics`).
- `Pi Code: Open Chat in Editor Tab` puts the same chat in an editor column beside the code.
- A status bar readout of pi's state and cost, with model, effort and context usage in the tooltip
  (`piCode.statusBar`).

## 0.3.0 and earlier

- Chat with tool calls and diffs, image attachments, `@` file mentions, `/` commands and `!` shell commands.
- Sessions panel with search, archive, rename and per-workspace scope.
- Model and reasoning-effort picker that understands gateways encoding effort in the model id.
