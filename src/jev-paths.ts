/** Wire Jev into existing MCP semantic paths without editing the global package. */
import {operations} from '../node_modules/gbrain/src/core/operations.ts';
import {activeJudge, JEV_MODEL, passageScoreQuestion, cacheKey, type JudgmentQuestion} from './jev-judgment.ts';
import {recordWorkEvent} from './work-events.ts';
import {enqueueJevWork} from './jev-work.ts';
import {enrichCapturedPage,installJevEnrichment} from './jev-enrichment.ts';

const EXACT = /^(?:brain|default):[a-z0-9][a-z0-9_/-]*$|^[a-z0-9]+(?:\/[a-z0-9_-]+)+$/i;
export const RANK_ENVELOPES = ['results', 'cards', 'facts', 'experts', 'items'] as const;

function wrap(name: string, handler: (original: any) => any) {
  const op = operations.find(item => item.name === name);
  if (!op || (op as any).__jev_wrapped) return;
  const original = op.handler.bind(op);
  op.handler = handler(original);
  (op as any).__jev_wrapped = true;
}

export function asList(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of RANK_ENVELOPES) {
      if (Array.isArray((value as any)[key])) return (value as any)[key];
    }
  }
  return [];
}

function textOf(row: any) {
  return String(row.chunk_text || row.compiled_truth || row.title || row.claim || row.text || '').slice(0, 1200);
}

function quoteExists(body: string, quote: string) {
  return !!quote && body.includes(quote);
}

export function keyedPassages(results: any[]) {
  const passages: Record<string, {slug?: string; text: string}> = {};
  for (const [i, row] of results.entries()) passages[`d${i}`] = {slug: row.slug, text: textOf(row)};
  return passages;
}

export function keyedClaims(claims: {text: string; quoted: boolean}[]) {
  const out: Record<string, {text: string; quoted: boolean}> = {};
  for (const [i, claim] of claims.entries()) out[`c${i}`] = claim;
  return out;
}

export function applyRanked(baseline: any, merged: any[]) {
  if (Array.isArray(baseline)) return merged;
  if (baseline && typeof baseline === 'object') {
    for (const key of RANK_ENVELOPES) {
      if (Array.isArray((baseline as any)[key])) return {...baseline, [key]: merged, jev_reranked: true};
    }
  }
  return baseline;
}

async function rerankList(ctx: any, query: string, baseline: any, feature: string, questionId = 'passage-rank-v1') {
  const results = asList(baseline).slice(0, 12);
  if (!query || EXACT.test(query.trim()) || results.length < 2) return baseline;
  try {
    const passages = keyedPassages(results);
    const questions: Record<string, JudgmentQuestion> = {};
    for (const [i] of results.entries()) questions[`d${i}`] = passageScoreQuestion(query, `passages.d${i}.text`);
    const judged = await activeJudge()({
      model: JEV_MODEL,
      state: {query, passages},
      questions,
    }, {
      engine: ctx.engine, trace_id: ctx.__work_trace_id, source_id: ctx.auth?.sourceId, identities: results.filter(row => row.slug).map(row => `${row.source_id || ctx.auth?.sourceId || 'brain'}:${row.slug}`), timeout_ms: 5000, feature: questionId,
      cache_key: cacheKey({
        evidence_versions: results.map(row => String(row.content_hash || row.slug)),
        candidate_hash: results.map(row => row.slug).join(','),
        model: JEV_MODEL, question_id: questionId, policy: 'gbrain-search-v1',
        auth_scope: (ctx.auth?.allowedSources ?? []).join(','), query,
      }),
    });
    if (!judged.ok) {
      await recordWorkEvent(ctx.engine, {actor: 'jev', actor_source: ctx.auth?.sourceId, trace_id: ctx.__work_trace_id, action: feature, phase: 'degraded', outcome: judged.failure,
        question_id: questionId, identities: results.map(row => `${row.source_id || ctx.auth?.sourceId || 'brain'}:${row.slug}`).filter(id => id.includes(':')),
        details: {fallback: 'baseline'}});
      if (baseline && typeof baseline === 'object' && !Array.isArray(baseline)) return {...baseline, degraded: {rerank: judged.failure}};
      return baseline;
    }
    const ranked = results.map((row, i) => {
      const answer = judged.response.answers[`d${i}`];
      const score = typeof answer?.score === 'number' ? answer.score : 0;
      return {row, score, i};
    }).sort((a, b) => b.score - a.score || a.i - b.i).map(item => item.row);
    const merged = [...ranked, ...asList(baseline).slice(12)];
    await enqueueJevWork(ctx.engine, {
      question_id: questionId, feature, identities: results.map(row => `${row.source_id || 'brain'}:${row.slug}`).filter(id => id.includes(':')),
      decision: {order: ranked.map(row => row.slug)}, state: 'applied',
    });
    await recordWorkEvent(ctx.engine, {actor: 'jev', actor_source: ctx.auth?.sourceId, trace_id: ctx.__work_trace_id, action: feature, phase: 'inferred', outcome: 'applied',
      question_id: questionId, model: JEV_MODEL, details: {cache: judged.cache}});
    return applyRanked(baseline, merged);
  } catch {
    return baseline;
  }
}

export function installJevProductionPaths() {
  for (const [name, field] of [['search','query'],['query','query'],['recall','query'],['find_experts','topic'],['context_pack','entities']]) {
    wrap(name, original => async (ctx:any,p:any) => rerankList(ctx,String(p[field] || ''),await original(ctx,p),name+'_rerank'));
  }
  installJevEnrichment();
  wrap('capture', original => async (ctx:any,p:any) => enrichCapturedPage(ctx,p,await original(ctx,p)));
}
export {rerankList};
