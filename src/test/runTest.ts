import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/** Boots a real VS Code, loads this extension into it and runs the suite in the extension host. */
/**
 * A terminal inside VS Code inherits VSCODE_* variables from the running extension host, and a
 * VS Code launched with those thinks it is itself an extension host and refuses its own CLI flags.
 */
function cleanEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') delete process.env[key];
  }
}

async function main(): Promise<void> {
  cleanEnv();
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // No positional folder here: Electron would take it for an app directory and run this
    // extension's own entry point outside the extension host.
    launchArgs: ['--disable-extensions', '--disable-gpu', '--no-sandbox'],
  });
}

main().catch(err => {
  console.error('integration tests failed:', err);
  process.exit(1);
});
