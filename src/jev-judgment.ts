/** Shared TypeSafe/Jev adapter for owner-side semantic paths. */
import {createHash} from 'node:crypto';
import {readFileSync, existsSync} from 'node:fs';
import {recordWorkEvent} from './work-events.ts';
import type {BrainEngine} from '../node_modules/gbrain/src/core/engine.ts';

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const QUESTION_REGISTRY_VERSION = 'gbrain-jev-questions-v1';

export type Primitive = 'choice' | 'score' | 'noul';
export type JudgmentQuestion = {
  type: Primitive;
  instructions: string;
  criteria: Record<string, string> | string[];
};
export type JudgmentRequest = {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, JudgmentQuestion>;
};
export type JudgmentFailure = 'timeout' | 'rate_limited' | 'invalid_structure' | 'model_uncertainty' | 'insufficient_evidence' | 'transport' | 'authentication' | 'http_error' | 'configuration';

const cache = new Map<string, {value: unknown; expires: number}>();
const inflight = new Map<string, Promise<unknown>>();

export function cacheKey(input: {
  evidence_versions: string[];
  candidate_hash: string;
  model: string;
  question_id: string;
  policy: string;
  auth_scope: string;
  query?: string;
  temporal?: string;
}) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function validateAnswers(request: JudgmentRequest, response: any) {
  if (!response || typeof response !== 'object' || response.model !== request.model) throw new Error('invalid_structure');
  const answers = response.answers;
  if (!answers || typeof answers !== 'object' || Object.keys(answers).sort().join() !== Object.keys(request.questions).sort().join()) {
    throw new Error('invalid_structure');
  }
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = answers[id];
    if (!answer || answer.type !== question.type) throw new Error('invalid_structure');
    if (question.type === 'choice') {
      const criteria = question.criteria as Record<string, string>;
      if (!(answer.choice in criteria)) throw new Error('invalid_structure');
      const probs = answer.probabilities;
      if (!probs || Object.keys(probs).sort().join() !== Object.keys(criteria).sort().join()) throw new Error('invalid_structure');
      const values = Object.values(probs) as number[];
      if (values.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) throw new Error('invalid_structure');
      if (Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.01) throw new Error('invalid_structure');
    } else if (question.type === 'noul') {
      if (typeof answer.noul !== 'number' || answer.noul < 0 || answer.noul > 1 || 'confidence' in answer || 'probability' in answer) {
        throw new Error('invalid_structure');
      }
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || typeof answer.score !== 'number') throw new Error('invalid_structure');
      const probs = answer.probabilities;
      const expected = question.criteria.map((_, i) => String(i)).sort().join();
      if (!probs || Object.keys(probs).sort().join() !== expected) throw new Error('invalid_structure');
    }
  }
  const usage = response.usage;
  if (!usage || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens)) throw new Error('invalid_structure');
}

export function parseEnvironmentKey(text: string): string | null {
  // Parse assignment syntax; never execute an env file or include its values in diagnostics.
  const match = text.match(/^\s*(?:export\s+)?(?:TYPESAFE_API_KEY|JEV_API_KEY|API_KEY)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#]+))\s*(?:#.*)?$/m);
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim() || null;
}

function loadKey() {
  const supplied = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
  if (supplied) return parseEnvironmentKey(`API_KEY=${supplied}`);
  const path = process.env.TYPESAFE_ENV;
  if (!path || !existsSync(path)) return null;
  return parseEnvironmentKey(readFileSync(path, 'utf8'));
}

export async function judge(request: JudgmentRequest, opts?: {
  engine?: BrainEngine;
  timeout_ms?: number;
  cache_key?: string;
  feature?: string;
  trace_id?: string;
  source_id?: string;
  identities?: string[];
}): Promise<{ok: true; response: any; cache: 'hit' | 'miss'} | {ok: false; failure: JudgmentFailure; unknown_usage?: boolean; http_status?: number; error_class?: string}> {
  const key = opts?.cache_key;
  if (key && cache.has(key) && cache.get(key)!.expires > Date.now()) {
    return {ok: true, response: cache.get(key)!.value, cache: 'hit'};
  }
  if (key && inflight.has(key)) {
    return await inflight.get(key) as Awaited<ReturnType<typeof judge>>;
  }
  const started = Date.now();
  const work = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeout_ms ?? 8000);
    try {
      const token = loadKey();
      if (!token) return {ok: false as const, failure: 'configuration' as const, error_class: 'missing_credential'};
      const res = await fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify(request),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!res.ok) {
        await res.body?.cancel();
        const failure: JudgmentFailure = res.status === 401 || res.status === 403 ? 'authentication'
          : res.status === 429 || res.status === 529 ? 'rate_limited'
          : res.status === 400 || res.status === 422 ? 'invalid_structure' : 'http_error';
        return {ok: false as const, failure, http_status: res.status};
      }
      let body: any;
      try {
        body = await res.json();
        validateAnswers(request, body);
      } catch {
        return {ok: false as const, failure: 'invalid_structure' as const, http_status: res.status, unknown_usage: true};
      }
      return {ok: true as const, response: body, cache: 'miss' as const};
    } catch (error) {
      const failure: JudgmentFailure = (error as any)?.name === 'AbortError' ? 'timeout' : 'transport';
      return {ok: false as const, failure, unknown_usage: true, error_class: error instanceof Error ? error.name : 'unknown'};
    } finally {
      clearTimeout(timer);
    }
  })();
  if (key) inflight.set(key, work);
  const result = await work;
  if (key) inflight.delete(key);
  if (result.ok && key) cache.set(key, {value: result.response, expires: Date.now() + 6 * 3600_000});
  try {
    const {addUsage, DEFAULT_LEDGER} = await import('./usage-ledger.ts');
    if (result.ok) addUsage(process.env.GBRAIN_JEV_LEDGER || DEFAULT_LEDGER, opts?.feature || 'judgment', result.response.usage.input_tokens);
  } catch {
    if (opts?.engine) await recordWorkEvent(opts.engine, {
      actor: 'jev', actor_source: opts.source_id, action: 'usage_accounting', phase: 'degraded',
      outcome: 'failed', error_class: 'ledger_write_failed', trace_id: opts.trace_id,
      identities: opts.identities, details: {feature: opts.feature, usage: result.ok ? result.response.usage : undefined},
    });
  }
  if (opts?.engine) {
    await recordWorkEvent(opts.engine, {
      actor: 'jev',
      actor_source: opts.source_id,
      action: opts.feature || 'judgment',
      phase: 'inferred',
      outcome: result.ok ? 'valid' : result.failure,
      model: JEV_MODEL,
      trace_id: opts.trace_id,
      question_id: opts.feature,
      identities: opts.identities,
      error_class: result.ok ? undefined : result.failure,
      usage: result.ok ? {reported: result.response.usage.input_tokens} : {unknown: true},
      details: {elapsed_ms: Date.now() - started, cache: result.ok ? result.cache : undefined,
        http_status: result.ok ? 200 : (result as any).http_status,
        error_class: result.ok ? undefined : (result as any).error_class,
        usage: result.ok ? result.response.usage : undefined},
    });
  }
  return result;
}

export function passageScoreQuestion(query: string, pointer: string): JudgmentQuestion {
  return {
    type: 'score',
    instructions: `Score how useful the passage at \`${pointer}\` is as evidence for the user query in \`query\`. Use only that passage's text. Exact identifiers and dates beat topical similarity. Hubs and repeated session copies score low unless they uniquely answer the query.`,
    criteria: [
      'Unrelated or boilerplate',
      'Weak topical overlap without the asked fact',
      'Partial evidence that needs other passages',
      'Directly answers a substantial part of the query',
      'Exact, dated, attributed evidence for the query',
    ],
  };
}

let judgeImpl = judge;
export function __setJudgeForTests(fn: typeof judge | null) {
  judgeImpl = fn || judge;
}
export function activeJudge() {
  return judgeImpl;
}
