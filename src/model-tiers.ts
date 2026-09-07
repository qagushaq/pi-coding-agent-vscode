/**
 * Some gateways (LiteLLM in front of Azure/OpenAI) expose the reasoning effort as part of the model id
 * — `gpt-6-astra-xhigh-fast` — instead of a request parameter. pi then reports `thinking: no` for every
 * model, and its `set_thinking_level` is a no-op. This module reads the effort back out of the ids so the
 * UI can offer a real family / effort / speed choice.
 */

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export type ParsedModel = { id: string; provider?: string; family: string; effort?: Effort; fast: boolean };

export type Family = {
  /** Model id prefix shared by the whole family, e.g. `gpt-6-astra`. */
  family: string;
  /** Efforts that actually exist as ids in this family, in EFFORTS order. */
  efforts: Effort[];
  /** True when at least one `-fast` variant exists. */
  hasFast: boolean;
  /** True when the bare family id (no effort suffix) exists. */
  hasBase: boolean;
};

const EFFORT_SET = new Set<string>(EFFORTS);

/** Split `gpt-6-astra-xhigh-fast` into family `gpt-6-astra`, effort `xhigh`, fast `true`. */
export function parseModelId(id: string, provider?: string): ParsedModel {
  let rest = id;
  let fast = false;
  if (rest.endsWith('-fast')) {
    fast = true;
    rest = rest.slice(0, -'-fast'.length);
  }
  let effort: Effort | undefined;
  const dash = rest.lastIndexOf('-');
  if (dash > 0) {
    const tail = rest.slice(dash + 1);
    if (EFFORT_SET.has(tail)) {
      effort = tail as Effort;
      rest = rest.slice(0, dash);
    }
  }
  return { id, provider, family: rest, effort, fast };
}

/** Group a provider's model list into families, keeping only families whose ids follow the effort convention. */
export function buildFamilies(models: { id: string; provider?: string }[]): Family[] {
  const map = new Map<string, Family>();
  for (const m of models) {
    const p = parseModelId(m.id, m.provider);
    let f = map.get(p.family);
    if (!f) {
      f = { family: p.family, efforts: [], hasFast: false, hasBase: false };
      map.set(p.family, f);
    }
    if (p.effort && !f.efforts.includes(p.effort)) f.efforts.push(p.effort);
    if (p.fast) f.hasFast = true;
    if (!p.effort && !p.fast) f.hasBase = true;
  }
  for (const f of map.values()) f.efforts.sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  return [...map.values()].sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * Build the id for a family at the requested effort and speed, falling back to what exists:
 * an unavailable effort drops to the nearest lower one, then to the bare family id.
 */
export function composeModelId(family: Family, effort: Effort | undefined, fast: boolean): string | undefined {
  const suffix = fast && family.hasFast ? '-fast' : '';
  if (effort && family.efforts.includes(effort)) return `${family.family}-${effort}${suffix}`;
  if (effort) {
    // Nearest lower available effort, so switching families never lands on a missing id.
    for (let i = EFFORTS.indexOf(effort) - 1; i >= 0; i--) {
      const e = EFFORTS[i];
      if (family.efforts.includes(e)) return `${family.family}-${e}${suffix}`;
    }
    for (const e of family.efforts) return `${family.family}-${e}${suffix}`;
  }
  if (family.hasBase || suffix) return `${family.family}${suffix}`;
  return undefined;
}

/** Human label for a family id: `gpt-6-astra` -> `GPT-6 Astra`. */
export function familyLabel(family: string): string {
  return family
    .split('-')
    .map(part => (/^gpt$/i.test(part) ? 'GPT' : /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
    .replace(/GPT (\d)/, 'GPT-$1');
}
