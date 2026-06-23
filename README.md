# Pi Coding Agent VS Code

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
2. Open the Pi Code activity bar item.
3. Send a prompt.
4. Configure command/model via VS Code settings:
   - `piCode.piCommand`
   - `piCode.defaultModel`
   - `piCode.extraArgs`
