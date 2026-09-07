#!/usr/bin/env node
/* Exercises the session listing against the real ~/.pi session store. Read-only. */
const { listSessions, readSessionInfo, bucketOf, ageLabel, sessionTitle, sessionDirFor } = require('../dist/sessions');
const path = require('path');
const os = require('os');

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} - ${msg}`);
};

const dir = sessionDirFor('/Users/cl/Documents/wash-back/rw-backend');
ok(dir.endsWith('--Users-cl-Documents-wash-back-rw-backend--'), `cwd maps to session dir: ${path.basename(dir)}`);

const all = listSessions(undefined);
ok(all.length > 0, `sessions found across workspaces: ${all.length}`);
ok(all.every(s => s.messageCount > 0), 'empty sessions filtered out');
ok(
  all.every((s, i) => i === 0 || all[i - 1].modifiedAt >= s.modifiedAt),
  'sorted newest first',
);
ok(all.every(s => path.isAbsolute(s.file) && path.isAbsolute(s.cwd)), 'absolute paths');

const byCwd = {};
for (const s of all) byCwd[s.cwd] = (byCwd[s.cwd] || 0) + 1;
console.log('     workspaces:', Object.entries(byCwd).map(([k, v]) => `${path.basename(k)}=${v}`).join(' '));

const scoped = listSessions('/Users/cl/Documents/wash-back/rw-backend');
ok(scoped.every(s => s.cwd === '/Users/cl/Documents/wash-back/rw-backend'), `workspace filter keeps only its own: ${scoped.length}`);
ok(scoped.length < all.length || Object.keys(byCwd).length === 1, 'workspace filter narrows the list');

const withModel = all.filter(s => s.model);
ok(withModel.length > 0, `model read from model_change entries (${withModel.length} sessions), e.g. ${withModel[0] && withModel[0].model}`);
const withPrompt = all.filter(s => s.firstPrompt);
ok(withPrompt.length > 0, 'first prompt extracted');

const now = new Date();
ok(['Today', 'Yesterday', 'This week', 'This month', 'Older'].includes(bucketOf(all[0].modifiedAt, now)), `newest bucket: ${bucketOf(all[0].modifiedAt, now)}`);
ok(bucketOf(new Date(now.getTime() - 60000), now) === 'Today', 'a minute ago is Today');
ok(bucketOf(new Date(now.getTime() - 400 * 86400000), now) === 'Older', 'a year ago is Older');
ok(/^\d+[mhdw]$/.test(ageLabel(all[0].modifiedAt, now)), `age label: ${ageLabel(all[0].modifiedAt, now)}`);
ok(ageLabel(new Date(now.getTime() - 90 * 60000), now) === '2h', '90 minutes reads as 2h');

ok(all.every(s => sessionTitle(s).length > 0), 'every session has a title');
ok(readSessionInfo(path.join(os.homedir(), 'nope.jsonl')) === undefined, 'missing file returns undefined');
ok(readSessionInfo(__filename) === undefined, 'non-session file returns undefined');

console.log('\nnewest five:');
for (const s of all.slice(0, 5)) {
  console.log(`  ${ageLabel(s.modifiedAt, now).padStart(4)}  ${String(s.messageCount).padStart(3)} msg  ${(s.model || '-').padEnd(24)} ${sessionTitle(s).slice(0, 46)}`);
}

console.log(failed ? `\nFAILED (${failed})` : '\nsessions check passed');
process.exit(failed ? 1 : 0);
