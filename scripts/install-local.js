#!/usr/bin/env node
/* Installs the .vsix this package.json describes, so the version can never drift from the manifest. */
const { execFileSync } = require('child_process');
const p = require('../package.json');
const vsix = `${p.name}-${p.version}.vsix`;
execFileSync('code', ['--install-extension', vsix, '--force'], { stdio: 'inherit' });
