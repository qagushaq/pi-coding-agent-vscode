#!/usr/bin/env node
/* Checks the family/effort parsing against the real model list of the configured gateway. */
const { parseModelId, buildFamilies, composeModelId, familyLabel } = require('../dist/model-tiers');

const ids = [
  'gpt-6-astra', 'gpt-6-astra-fast', 'gpt-6-astra-low', 'gpt-6-astra-low-fast', 'gpt-6-astra-medium', 'gpt-6-astra-medium-fast',
  'gpt-6-astra-high', 'gpt-6-astra-high-fast', 'gpt-6-astra-xhigh', 'gpt-6-astra-xhigh-fast', 'gpt-6-astra-max', 'gpt-6-astra-max-fast',
  'gpt-5.6-sol', 'gpt-5.6-sol-fast', 'gpt-5.6-sol-low', 'gpt-5.6-sol-low-fast', 'gpt-5.6-sol-medium', 'gpt-5.6-sol-medium-fast',
  'gpt-5.6-sol-high', 'gpt-5.6-sol-high-fast',
  'gpt-5.5', 'gpt-5.5-high', 'gpt-5.5-high-fast', 'gpt-5.5-low', 'gpt-5.5-medium',
  'gpt-5.3-codex-spark', 'gpt-5.3-codex-spark-low', 'gpt-5.3-codex-spark-medium', 'gpt-5.3-codex-spark-high',
  'gpt-5.4-mini', 'gpt-5.4-mini-low', 'claude-opus-4-8',
].map(id => ({ id, provider: 'litellm' }));

let failed = 0;
const eq = (got, want, msg) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${msg}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

eq(parseModelId('gpt-6-astra-xhigh-fast'), { id: 'gpt-6-astra-xhigh-fast', provider: undefined, family: 'gpt-6-astra', effort: 'xhigh', fast: true }, 'effort + fast');
eq(parseModelId('gpt-6-astra'), { id: 'gpt-6-astra', provider: undefined, family: 'gpt-6-astra', effort: undefined, fast: false }, 'bare family');
eq(parseModelId('gpt-6-astra-fast').family, 'gpt-6-astra', 'fast without effort keeps family');
eq(parseModelId('gpt-5.3-codex-spark-high').family, 'gpt-5.3-codex-spark', 'multi-dash family');
eq(parseModelId('gpt-5.4-mini').family, 'gpt-5.4-mini', 'mini is part of the family, not an effort');
eq(parseModelId('claude-opus-4-8').effort, undefined, 'unrelated id has no effort');

const fams = buildFamilies(ids);
eq(fams.map(f => f.family), ['claude-opus-4-8', 'gpt-5.3-codex-spark', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-6-astra'], 'families discovered');
const astra = fams.find(f => f.family === 'gpt-6-astra');
eq(astra.efforts, ['low', 'medium', 'high', 'xhigh', 'max'], 'astra efforts in ladder order');
eq(astra.hasFast && astra.hasBase, true, 'astra has fast and base');
const sol = fams.find(f => f.family === 'gpt-5.6-sol');
eq(sol.efforts, ['low', 'medium', 'high'], 'sol has no xhigh/max');

eq(composeModelId(astra, 'max', true), 'gpt-6-astra-max-fast', 'compose max fast');
eq(composeModelId(astra, 'max', false), 'gpt-6-astra-max', 'compose max');
eq(composeModelId(sol, 'max', true), 'gpt-5.6-sol-high-fast', 'max on sol falls back to high');
eq(composeModelId(sol, 'xhigh', false), 'gpt-5.6-sol-high', 'xhigh on sol falls back to high');
eq(composeModelId(fams.find(f => f.family === 'claude-opus-4-8'), 'high', false), 'claude-opus-4-8', 'effortless family returns its bare id');
eq(familyLabel('gpt-6-astra'), 'GPT-6 Astra', 'label astra');
eq(familyLabel('gpt-5.3-codex-spark'), 'GPT-5.3 Codex Spark', 'label codex spark');

console.log(failed ? `FAILED (${failed})` : 'tiers check passed');
process.exit(failed ? 1 : 0);
