/** Durable Jev work items on the owner. Idempotent by decision digest.
 * Queued graph work is drained by the authenticated owner with conditional receipts.
 */
import {createHash} from 'node:crypto';
import type {BrainEngine} from '../node_modules/gbrain/src/core/engine.ts';

export type JevWorkState = 'queued' | 'applied' | 'abstained' | 'failed';

export async function ensureJevWork(engine: BrainEngine) {
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS maintenance_jev_work (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    feature TEXT NOT NULL,
    identities JSONB,
    decision JSONB NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','applied','abstained','failed')),
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}

export async function enqueueJevWork(engine: BrainEngine, item: {
  question_id: string;
  feature: string;
  identities?: string[];
  decision: unknown;
  state: JevWorkState;
  details?: Record<string, unknown>;
  revision?: string;
}) {
  await ensureJevWork(engine);
  const id = createHash('sha256').update(JSON.stringify({
    question_id: item.question_id,
    identities: item.identities || [],
    decision: item.decision,
    revision: item.revision,
  })).digest('hex').slice(0, 40);
  await engine.executeRaw(
    `INSERT INTO maintenance_jev_work(id,question_id,feature,identities,decision,state,details)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, item.question_id, item.feature, JSON.stringify(item.identities || []),
      JSON.stringify(item.decision), item.state, JSON.stringify(item.details || {})]);
  const stored = await engine.executeRaw<any>('SELECT state FROM maintenance_jev_work WHERE id=$1', [id]);
  return {id, state: stored[0]?.state ?? item.state};
}

export async function listJevWork(engine: BrainEngine, state?: JevWorkState) {
  await ensureJevWork(engine);
  if (state) {
    return engine.executeRaw<any>('SELECT id, question_id, feature, state, decision FROM maintenance_jev_work WHERE state=$1', [state]);
  }
  return engine.executeRaw<any>('SELECT id, question_id, feature, state, decision FROM maintenance_jev_work');
}
