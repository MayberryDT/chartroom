/** Bounded owner-side graph publication. Graph-only: no page re-embed. */
import {createHash} from 'node:crypto';
import type {BrainEngine} from '../node_modules/gbrain/src/core/engine.ts';
import {operations, type OperationContext} from '../node_modules/gbrain/src/core/operations.ts';
import {MANAGED_LINK_SOURCES} from '../node_modules/gbrain/src/core/ops/links.ts';
import {invalidateQueryCache} from '../node_modules/gbrain/src/core/schema-pack/query-cache-invalidator.ts';
import {revision} from './revision.ts';
import {recordWorkEvent} from './work-events.ts';

export const LINK_BATCH_LIMIT = 100;
export const LINK_BATCH_OP = 'maintenance_link_batch';
const PROVENANCE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ITEM_ID = /^[a-zA-Z0-9._:-]{1,100}$/;
const SLUG = /^[a-z0-9][a-z0-9_/-]*$/;
const SOURCE = /^[a-z][a-z0-9_-]{0,40}$/;
const RELATIONS = new Set(['', 'about', 'supports', 'applies_to', 'supersedes', 'contradicts']);

export type Endpoint = {source_id: string; slug: string};
export type LinkItem = {
  id: string;
  from: Endpoint;
  to: Endpoint;
  provenance: string;
  relation?: string;
  context?: string;
  expected_from_revision?: string;
  expected_to_revision?: string;
  evidence?: {source_id: string; slug: string; revision: string; quote: string};
};
export type LinkBatchRequest = {batch_id: string; items: LinkItem[]; undo?: boolean};
export type ItemOutcome = 'added' | 'already_present' | 'stale' | 'denied' | 'missing' | 'invalid' | 'retryable' | 'conflict' | 'undone';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function identity(end: Endpoint) {
  return `${end.source_id}:${end.slug}`;
}

function requestHash(req: LinkBatchRequest) {
  return digest({batch_id: req.batch_id, items: req.items, undo: !!req.undo});
}

function endpointOk(end: unknown): end is Endpoint {
  return !!end && typeof end === 'object'
    && typeof (end as Endpoint).source_id === 'string' && SOURCE.test((end as Endpoint).source_id)
    && typeof (end as Endpoint).slug === 'string' && SLUG.test((end as Endpoint).slug);
}

export function validateShape(raw: unknown): LinkBatchRequest {
  if (!raw || typeof raw !== 'object') throw new Error('invalid_batch');
  const req = raw as LinkBatchRequest;
  if (typeof req.batch_id !== 'string' || !ITEM_ID.test(req.batch_id)) throw new Error('invalid_batch_id');
  if (req.undo === true) return {batch_id: req.batch_id, items: [], undo: true};
  if (!Array.isArray(req.items) || req.items.length === 0 || req.items.length > LINK_BATCH_LIMIT) throw new Error('invalid_batch_size');
  const ids = new Set<string>();
  for (const item of req.items) {
    if (!item || typeof item.id !== 'string' || !ITEM_ID.test(item.id) || ids.has(item.id)) throw new Error('invalid_item_id');
    ids.add(item.id);
    if (!endpointOk(item.from) || !endpointOk(item.to) || identity(item.from) === identity(item.to)) throw new Error('invalid_endpoints');
    if (typeof item.provenance !== 'string' || !PROVENANCE.test(item.provenance) || item.provenance.length > 64
      || MANAGED_LINK_SOURCES.includes(item.provenance)) throw new Error('invalid_provenance');
    const relation = item.relation ?? '';
    if (typeof relation !== 'string' || !RELATIONS.has(relation)) throw new Error('invalid_relation');
    if (item.context !== undefined && (typeof item.context !== 'string' || item.context.length > 4000)) throw new Error('invalid_context');
    for (const key of ['expected_from_revision', 'expected_to_revision'] as const) {
      const value = item[key];
      if (value !== undefined && (typeof value !== 'string' || value.length < 16 || value.length > 128)) throw new Error('invalid_revision');
    }
    if (item.evidence) {
      const e = item.evidence;
      if (!SOURCE.test(e.source_id) || !SLUG.test(e.slug) || typeof e.revision !== 'string' || typeof e.quote !== 'string'
        || !e.quote || e.quote.length > 20000) throw new Error('invalid_evidence');
    }
  }
  return req;
}

async function matchesRevision(page: {content_hash?: string} | null, expected?: string) {
  if (!expected) return true;
  if (!page) return false;
  const maint = revision(page as any);
  return page.content_hash === expected || maint === expected;
}

async function existingEdge(tx: BrainEngine, item: LinkItem) {
  const rows = await tx.executeRaw<{n: number}>(
    `SELECT count(*)::int AS n FROM links l
      JOIN pages f ON f.id=l.from_page_id
      JOIN pages t ON t.id=l.to_page_id
     WHERE f.source_id=$1 AND f.slug=$2 AND t.source_id=$3 AND t.slug=$4
       AND l.link_type IS NOT DISTINCT FROM $5 AND l.link_source IS NOT DISTINCT FROM $6`,
    [item.from.source_id, item.from.slug, item.to.source_id, item.to.slug, item.relation ?? '', item.provenance]);
  return (rows[0]?.n ?? 0) > 0;
}

function grantSources(ctx: OperationContext) {
  if (!ctx.auth?.sourceId) throw new Error('explicit authenticated source required');
  return {write: ctx.auth.sourceId, read: ctx.auth.allowedSources ?? [ctx.auth.sourceId]};
}

async function classify(tx: BrainEngine, ctx: OperationContext, item: LinkItem): Promise<ItemOutcome> {
  const grant = grantSources(ctx);
  if (!grant.read.includes(item.from.source_id) || !grant.read.includes(item.to.source_id)) return 'denied';
  if (item.from.source_id !== grant.write) return 'denied';
  const from = await tx.getPage(item.from.slug, {sourceId: item.from.source_id});
  const to = await tx.getPage(item.to.slug, {sourceId: item.to.source_id});
  if (!from || !to) return 'missing';
  if (from.frontmatter?.visibility === 'private' && ctx.remote) return 'denied';
  if (to.frontmatter?.visibility === 'private' && ctx.remote) return 'denied';
  if (!(await matchesRevision(from, item.expected_from_revision))) return 'stale';
  if (!(await matchesRevision(to, item.expected_to_revision))) return 'stale';
  if (item.evidence) {
    if (!grant.read.includes(item.evidence.source_id)) return 'denied';
    const evidence = await tx.getPage(item.evidence.slug, {sourceId: item.evidence.source_id});
    if (!evidence) return 'missing';
    if (!(await matchesRevision(evidence, item.evidence.revision))) return 'stale';
    if (!evidence.compiled_truth.includes(item.evidence.quote)) return 'stale';
  }
  if (await existingEdge(tx, item)) return 'already_present';
  return 'added';
}

export async function ensureLinkLedger(engine: BrainEngine) {
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS maintenance_link_batch_receipts (
    id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, actor_source TEXT NOT NULL,
    item_count INTEGER NOT NULL, outcomes JSONB NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('committed','undone')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS maintenance_link_item_receipts (
    batch_id TEXT NOT NULL, item_id TEXT NOT NULL, outcome TEXT NOT NULL,
    from_source TEXT NOT NULL, from_slug TEXT NOT NULL, to_source TEXT NOT NULL, to_slug TEXT NOT NULL,
    link_type TEXT NOT NULL, link_source TEXT NOT NULL, request_hash TEXT NOT NULL,
    PRIMARY KEY (batch_id, item_id))`);
}

async function undoBatch(engine: BrainEngine, ctx: OperationContext, batchId: string) {
  const grant = grantSources(ctx);
  return engine.transaction(async tx => {
    const batches = await tx.executeRaw<{request_hash: string; actor_source: string; state: string}>(
      'SELECT request_hash, actor_source, state FROM maintenance_link_batch_receipts WHERE id=$1 FOR UPDATE', [batchId]);
    if (!batches.length) throw new Error('operation_not_found');
    const batch = batches[0];
    if (batch.actor_source !== grant.write) throw new Error('scope_denied');
    if (batch.state === 'undone') {
      const items = await tx.executeRaw<any>('SELECT * FROM maintenance_link_item_receipts WHERE batch_id=$1', [batchId]);
      return {batch_id: batchId, state: 'undone', items: items.map((row: any) => ({id: row.item_id, outcome: row.outcome}))};
    }
    const added = await tx.executeRaw<any>(
      "SELECT * FROM maintenance_link_item_receipts WHERE batch_id=$1 AND outcome='added' FOR UPDATE", [batchId]);
    for (const row of added) {
      await tx.removeLink(row.from_slug, row.to_slug, row.link_type, row.link_source,
        {fromSourceId: row.from_source, toSourceId: row.to_source});
    }
    await tx.executeRaw("UPDATE maintenance_link_batch_receipts SET state='undone' WHERE id=$1", [batchId]);
    await tx.executeRaw("UPDATE maintenance_link_item_receipts SET outcome='undone' WHERE batch_id=$1 AND outcome='added'", [batchId]);
    const items = await tx.executeRaw<any>('SELECT * FROM maintenance_link_item_receipts WHERE batch_id=$1', [batchId]);
    return {batch_id: batchId, state: 'undone', items: items.map((row: any) => ({id: row.item_id, outcome: row.outcome}))};
  });
}

export async function applyLinkBatch(engine: BrainEngine, ctx: OperationContext, raw: unknown) {
  const req = validateShape(raw);
  await ensureLinkLedger(engine);
  if (req.undo) return undoBatch(engine, ctx, req.batch_id);
  const grant = grantSources(ctx);
  const hash = requestHash(req);
  const result = await engine.transaction(async tx => {
    const prior = await tx.executeRaw<{request_hash: string; outcomes: any; state: string; actor_source: string}>(
      'SELECT request_hash, outcomes, state, actor_source FROM maintenance_link_batch_receipts WHERE id=$1 FOR UPDATE', [req.batch_id]);
    if (prior.length) {
      if (prior[0].actor_source !== grant.write) throw new Error('receipt_scope_denied');
      if (prior[0].request_hash !== hash) throw new Error('operation_id_reused');
      return {batch_id: req.batch_id, state: prior[0].state, replayed: true, items: prior[0].outcomes};
    }
    const identities = [...new Set(req.items.flatMap(item => [identity(item.from), identity(item.to)]))].sort();
    for (const id of identities) {
      const [source, ...rest] = id.split(':');
      await tx.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR UPDATE', [source, rest.join(':')]);
    }
    const items: {id: string; outcome: ItemOutcome}[] = [];
    for (const item of req.items) {
      const outcome = await classify(tx, ctx, item);
      if (outcome === 'added') {
        await tx.addLink(
          item.from.slug, item.to.slug, item.context || '', item.relation ?? '', item.provenance,
          undefined, undefined,
          {fromSourceId: item.from.source_id, toSourceId: item.to.source_id, originSourceId: item.from.source_id},
        );
      }
      items.push({id: item.id, outcome});
      await tx.executeRaw(
        `INSERT INTO maintenance_link_item_receipts
         (batch_id,item_id,outcome,from_source,from_slug,to_source,to_slug,link_type,link_source,request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.batch_id, item.id, outcome, item.from.source_id, item.from.slug, item.to.source_id, item.to.slug,
          item.relation ?? '', item.provenance, digest(item)]);
    }
    await tx.executeRaw(
      `INSERT INTO maintenance_link_batch_receipts
       (id,request_hash,actor_source,item_count,outcomes,state) VALUES ($1,$2,$3,$4,$5::jsonb,'committed')`,
      [req.batch_id, hash, grant.write, req.items.length, JSON.stringify(items)]);
    return {batch_id: req.batch_id, state: 'committed', replayed: false, items};
  });
  const sources = [...new Set(req.items.map(item => item.from.source_id))];
  for (const source of sources) await invalidateQueryCache(engine, source);
  const identities = [...new Set(req.items.flatMap(item => [identity(item.from), identity(item.to)]))];
  const recorded = await recordWorkEvent(engine, {
    action: 'maintenance_link_batch',
    phase: 'published',
    actor: 'owner',
    actor_source: grant.write,
    outcome: result.state,
    trace_id: req.batch_id,
    request_id: req.batch_id,
    operation_id: req.batch_id,
    identities,
    details: {replayed: result.replayed, counts: countOutcomes(result.items)},
  });
  if (recorded.degraded) {
    await recordWorkEvent(engine, {
      action: 'maintenance_link_batch', phase: 'logged', actor: 'owner', outcome: 'gap',
      trace_id: req.batch_id, identities, error_class: 'telemetry_unavailable',
      details: {gap: recorded},
    }).catch(() => ({degraded: true}));
  }
  return result;
}

function countOutcomes(items: {outcome: string}[]) {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.outcome] = (counts[item.outcome] || 0) + 1;
  return counts;
}

export function installLinkBatch() {
  if (operations.some(op => op.name === LINK_BATCH_OP)) return;
  operations.push({
    name: LINK_BATCH_OP,
    description: 'Commit a bounded, source-qualified graph batch with per-item receipts. Graph-only: does not rewrite page text.',
    scope: 'write',
    mutating: true,
    params: {
      batch_id: {type: 'string', required: true},
      items: {type: 'array'},
      undo: {type: 'boolean'},
    },
    handler: async (ctx, p) => applyLinkBatch(ctx.engine, ctx, p),
  }, {
    name: 'maintenance_link_receipt',
    description: 'Read a source-scoped link-batch receipt to reconcile a lost response.',
    scope: 'read',
    params: {source_id: {type: 'string', required: true}, id: {type: 'string', required: true}},
    handler: async (ctx, p) => {
      const grant = grantSources(ctx);
      const source = p.source_id as string, id = p.id as string;
      if (!grant.read.includes(source) || !ITEM_ID.test(id)) throw new Error('receipt_scope_denied');
      await ensureLinkLedger(ctx.engine);
      const rows = await ctx.engine.executeRaw<any>(
        'SELECT * FROM maintenance_link_batch_receipts WHERE id=$1 AND actor_source=$2', [id, source]);
      if (!rows.length) return {found: false, id, source};
      const items = await ctx.engine.executeRaw<any>(
        'SELECT item_id, outcome, from_source, from_slug, to_source, to_slug FROM maintenance_link_item_receipts WHERE batch_id=$1', [id]);
      return {found: true, id, source, state: rows[0].state, request_hash: rows[0].request_hash, items};
    },
  });
}
