/** Common work-event envelope. Owner-side durable buffer; never blocks search. */
import type {BrainEngine} from '../node_modules/gbrain/src/core/engine.ts';
import {operations, type OperationContext} from '../node_modules/gbrain/src/core/operations.ts';

export const WORK_EVENT_SCHEMA = 1;

export type WorkEvent = {
  schema_version?: number;
  ts?: string;
  trace_id?: string;
  run_id?: string;
  operation_id?: string;
  request_id?: string;
  parent_id?: string;
  actor: string;
  harness?: string;
  action: string;
  phase: string;
  outcome: string;
  error_class?: string;
  identities?: string[];
  model?: string;
  question_id?: string;
  policy_version?: string;
  usage?: {reported?: number; estimated?: number; unknown?: boolean};
  details?: Record<string, unknown>;
};

export async function ensureWorkEvents(engine: BrainEngine) {
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS maintenance_work_events (
    id BIGSERIAL PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    trace_id TEXT,
    run_id TEXT,
    operation_id TEXT,
    request_id TEXT,
    parent_id TEXT,
    actor TEXT NOT NULL,
    actor_source TEXT,
    harness TEXT,
    action TEXT NOT NULL,
    phase TEXT NOT NULL,
    outcome TEXT NOT NULL,
    error_class TEXT,
    identities JSONB,
    model TEXT,
    question_id TEXT,
    policy_version TEXT,
    usage JSONB,
    details JSONB)`);
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS maintenance_work_event_gaps (
    id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(), action TEXT, error TEXT, payload JSONB)`);
  await engine.executeRaw('CREATE INDEX IF NOT EXISTS maintenance_work_events_trace ON maintenance_work_events(trace_id)');
  await engine.executeRaw('CREATE INDEX IF NOT EXISTS maintenance_work_events_action ON maintenance_work_events(action, ts DESC)');
  await engine.executeRaw('ALTER TABLE maintenance_work_events ADD COLUMN IF NOT EXISTS actor_source TEXT');
}

export async function recordWorkEvent(engine: BrainEngine, event: WorkEvent & {actor_source?: string}) {
  try {
    await ensureWorkEvents(engine);
    await engine.executeRaw(
      `INSERT INTO maintenance_work_events
        (schema_version,trace_id,run_id,operation_id,request_id,parent_id,actor,actor_source,harness,action,phase,outcome,error_class,identities,model,question_id,policy_version,usage,details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18::jsonb,$19::jsonb)`,
      [event.schema_version ?? WORK_EVENT_SCHEMA, event.trace_id ?? null, event.run_id ?? null,
        event.operation_id ?? null, event.request_id ?? null, event.parent_id ?? null,
        event.actor, event.actor_source ?? sourceOf(event.identities), event.harness ?? null, event.action, event.phase, event.outcome,
        event.error_class ?? null, JSON.stringify(event.identities ?? []), event.model ?? null,
        event.question_id ?? null, event.policy_version ?? null,
        JSON.stringify(event.usage ?? {}), JSON.stringify(event.details ?? {})]);
  } catch (error) {
    try {
      await engine.executeRaw(
        'INSERT INTO maintenance_work_event_gaps(action,error,payload) VALUES ($1,$2,$3::jsonb)',
        [event.action, error instanceof Error ? error.name : 'unknown', JSON.stringify({trace_id: event.trace_id, identities: event.identities})]);
    } catch {
      /* keep search available */
    }
    return {degraded: true, error: error instanceof Error ? error.name : 'unknown'};
  }
  return {degraded: false};
}

function sourceOf(identities?: string[]) {
  if (!identities?.length) return null;
  return identities[0].split(':')[0];
}

function parseIdentities(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function redactEvent(row: any, allowed: string[]) {
  const identities = parseIdentities(row.identities).filter(id => allowed.includes(id.split(':')[0]));
  const actorOk = typeof row.actor_source === 'string' && allowed.includes(row.actor_source);
  if (!actorOk && !identities.length) return null;
  const {actor_source: _actor, ...rest} = row;
  return {...rest, identities};
}

function grant(ctx: OperationContext) {
  if (!ctx.auth?.sourceId) throw new Error('explicit authenticated source required');
  const listed = ctx.auth.allowedSources;
  if (Array.isArray(listed) && listed.length) return listed;
  return [ctx.auth.sourceId];
}

function identityFrom(name: string, p: any, ctx: OperationContext) {
  const source = (p.source_id as string) || ctx.auth?.sourceId;
  const slug = (p.slug as string) || (p.from as string);
  if (name === 'add_link' && p.from && p.to && source) return [`${source}:${p.from}`, `${source}:${p.to}`];
  if (source && slug) return [`${source}:${slug}`];
  return [];
}

function wrapBoundary(name: string, phase: string) {
  const op = operations.find(item => item.name === name);
  if (!op || (op as any).__work_logged) return;
  const original = op.handler.bind(op);
  op.handler = async (ctx, p) => {
    try {
      (ctx as any).__work_trace_id ||= crypto.randomUUID();
      const result = await original(ctx, p);
      await recordWorkEvent(ctx.engine, {actor: 'mcp', trace_id: (ctx as any).__work_trace_id, action: name, phase, outcome: result && typeof result === 'object' && ('error' in result || 'rpc_error' in result) ? 'error' : 'ok',
        identities: identityFrom(name, p, ctx), actor_source: ctx.auth?.sourceId});
      return result;
    } catch (error) {
      await recordWorkEvent(ctx.engine, {actor: 'mcp', trace_id: (ctx as any).__work_trace_id, action: name, phase, outcome: 'error',
        error_class: error instanceof Error ? error.name : 'unknown', actor_source: ctx.auth?.sourceId,
        identities: identityFrom(name, p, ctx)});
      throw error;
    }
  };
  (op as any).__work_logged = true;
}

export function installWorkHistory() {
  for (const op of operations) {
    if (op.name !== 'maintenance_work_history') wrapBoundary(op.name, op.mutating ? 'published' : 'read');
  }
  if (operations.some(op => op.name === 'maintenance_work_history')) return;
  operations.push({
    name: 'maintenance_work_history',
    description: 'Query durable GBrain work events for a page, operation, run or trace. Private payloads are omitted.',
    scope: 'read',
    params: {
      source_id: {type: 'string'},
      slug: {type: 'string'},
      operation_id: {type: 'string'},
      run_id: {type: 'string'},
      trace_id: {type: 'string'},
      limit: {type: 'number'},
    },
    handler: async (ctx, p) => {
      const allowed = grant(ctx);
      await ensureWorkEvents(ctx.engine);
      const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 200);
      const identity = typeof p.source_id === 'string' && typeof p.slug === 'string' ? `${p.source_id}:${p.slug}` : null;
      if (identity && !allowed.includes(p.source_id as string)) throw new Error('history_scope_denied');
      const grantList = allowed.join(',');
      const rows = await ctx.engine.executeRaw<any>(
        `SELECT id, schema_version, ts, trace_id, run_id, operation_id, request_id, actor, actor_source, action, phase, outcome,
                error_class, identities, model, question_id, policy_version
           FROM maintenance_work_events
          WHERE ($1::text IS NULL OR trace_id=$1)
            AND ($2::text IS NULL OR run_id=$2)
            AND ($3::text IS NULL OR operation_id=$3)
            AND ($4::text IS NULL OR identities::text LIKE '%' || $4 || '%')
            AND (
              COALESCE(actor_source, '') = ANY(string_to_array($6, ','))
              OR EXISTS (
                SELECT 1 FROM unnest(string_to_array($6, ',')) AS g(src)
                WHERE identities::text LIKE '%"' || g.src || ':%'
              )
            )
          ORDER BY ts DESC, id DESC LIMIT $5`,
        [p.trace_id ?? null, p.run_id ?? null, p.operation_id ?? null, identity, limit, grantList]);
      const events = rows.map((row: any) => redactEvent(row, allowed)).filter((row: any) => row !== null);
      const latest = events[0] || null;
      const gaps = await ctx.engine.executeRaw<any>('SELECT count(*)::int AS n FROM maintenance_work_event_gaps');
      return {
        events,
        logging_gaps: gaps[0]?.n ?? 0,
        last_successful: events.find((row: any) => row.outcome === 'committed' || row.outcome === 'verified' || row.phase === 'published') || latest,
        current_phase: latest?.phase ?? null,
        resume: latest ? {action: latest.action, phase: latest.phase, outcome: latest.outcome, operation_id: latest.operation_id, run_id: latest.run_id} : null,
      };
    },
  });
}
