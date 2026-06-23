# Pi Coding Agent VS Code

**Language / Язык:** English | [Русский](README.ru.md)

VS Code extension wrapper for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) RPC mode.

## Current MVP

- Sidebar chat UI
- Multiple task tabs
- Starts `pi --mode rpc` per task
- Streaming assistant output
- Tool execution blocks
- Stop/restart task
- Model selector
- Attach image from file
- Image preview before sending
- Remove attached images before sending
- Paste/drop images into the chat
- Basic startup error reporting when `pi` is not found
- Rename tasks and sync names to Pi sessions
- Clear task status indicators: idle/running/error
- Show Pi session file/id
- Copy session path
- Export current session to HTML

## Development

```bash
npm install
npm run compile
```

Package VSIX:

```bash
npx @vscode/vsce package --no-dependencies
```

## Usage

1. Install the extension VSIX.
2. Reload the VS Code window.
3. Open the Pi Code activity bar item.
4. Send a prompt.
5. Configure command/model via VS Code settings:
   - `piCode.piCommand`
   - `piCode.defaultModel`
   - `piCode.extraArgs`

## Local install

```bash
npm run package
code --install-extension pi-coding-agent-vscode-0.1.0.vsix --force
```

Then run `Developer: Reload Window` in VS Code.

## Test checklist

- Pi Code icon appears in the Activity Bar.
- New task starts without `pi` command errors.
- Sending a prompt streams the assistant response.
- Tool executions appear as tool blocks.
- New/Rename/Restart/Stop buttons work.
- Model selector is populated.
- Attach/paste/drop image shows preview and sends it with the prompt.
- Copy session copies the current Pi session file path.
- Export HTML writes an HTML transcript path into the chat.
