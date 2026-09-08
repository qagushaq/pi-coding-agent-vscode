import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'local.pi-coding-agent-vscode';

suite('Pi Code in a real extension host', () => {
  test('the extension activates', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, 'extension not found in the host');
    await ext!.activate();
    assert.ok(ext!.isActive);
  });

  test('every contributed command is registered', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID)!;
    await ext.activate();
    const declared: string[] = (ext.packageJSON.contributes.commands || []).map((c: any) => c.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = declared.filter(c => !registered.has(c));
    assert.deepStrictEqual(missing, [], `commands declared but never registered: ${missing.join(', ')}`);
  });

  test('the chat view opens and the webview survives a state push', async () => {
    // This is the path that the fan-out recursion broke: focusing the view renders the webview and
    // pushes state into it. A throw here fails the test instead of silently emptying the chat.
    await vscode.commands.executeCommand('piCode.chatView.focus');
    await new Promise(r => setTimeout(r, 2000));
    await vscode.commands.executeCommand('piCode.focus');
    await new Promise(r => setTimeout(r, 500));
  });

  test('opening the chat in an editor tab works', async () => {
    await vscode.commands.executeCommand('piCode.openInEditor');
    await new Promise(r => setTimeout(r, 1500));
    await vscode.commands.executeCommand('piCode.focus');
  });
});
