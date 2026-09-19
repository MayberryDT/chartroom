/** Shared Jev spending file used by Python and native runtimes.
 * Serialization: exclusive mkdir of `${path}.lock` (same protocol as jev/client.py).
 * An unreadable existing file is never treated as a new zeroed account.
 */
import {existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, renameSync} from 'node:fs';
import {dirname} from 'node:path';

export const DEFAULT_LEDGER = `${process.env.CHARTROOM_HOME || '.chartroom'}/jev-usage.json`;
export const FIXTURE_RATE = 0.042 / 1_000_000;

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

function emptyAccount(budget = 100) {
  return {budget_usd: budget, accounted_usd: 0, reserved_usd: 0, unknown_usd: 0, by_feature: {} as Record<string, {reserved?: number; accounted?: number}>};
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(path: string, fn: () => T, timeoutMs = 5000): T {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const lock = `${path}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() - start > timeoutMs) throw new LedgerError('ledger lock timeout');
      sleep(10);
    }
  }
  try {
    return fn();
  } finally {
    try { rmdirSync(lock); } catch { /* lost lock */ }
  }
}

export function loadLedger(path = process.env.GBRAIN_JEV_LEDGER || DEFAULT_LEDGER) {
  if (!existsSync(path)) return emptyAccount();
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new LedgerError('unreadable existing accounting');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LedgerError('unreadable existing accounting');
  }
  return parsed;
}

function saveLedger(path: string, current: any) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  writeFileSync(path + '.tmp', JSON.stringify(current), {mode: 0o600});
  renameSync(path + '.tmp', path);
}

export function reserve(path: string, estimate: number, feature = 'unspecified', budget = 100) {
  return withLock(path, () => {
    const current = existsSync(path) ? loadLedger(path) : emptyAccount(budget);
    const charged = Number(current.accounted_usd || 0);
    const inflight = Number(current.reserved_usd || 0);
    const unknown = Number(current.unknown_usd || 0);
    const limit = Number(current.budget_usd || budget);
    if (charged + inflight + unknown + estimate > limit) return {ok: false, current};
    current.reserved_usd = inflight + estimate;
    current.by_feature = current.by_feature || {};
    current.by_feature[feature] = current.by_feature[feature] || {reserved: 0, accounted: 0};
    current.by_feature[feature].reserved = Number(current.by_feature[feature].reserved || 0) + estimate;
    current.updated = Date.now() / 1000;
    saveLedger(path, current);
    return {ok: true, current};
  });
}

export function settle(path: string, opts: {
  estimate?: number; tokens?: number; feature?: string; unknown?: boolean; rate?: number;
}) {
  const feature = opts.feature || 'unspecified';
  const rate = opts.rate ?? FIXTURE_RATE;
  const estimate = opts.estimate || 0;
  return withLock(path, () => {
    const current = existsSync(path) ? loadLedger(path) : emptyAccount();
    current.reserved_usd = Math.max(0, Number(current.reserved_usd || 0) - estimate);
    const cost = opts.unknown ? estimate : (opts.tokens || 0) * rate;
    if (opts.unknown) current.unknown_usd = Number(current.unknown_usd || 0) + cost;
    else current.accounted_usd = Number(current.accounted_usd || 0) + cost;
    current.by_feature = current.by_feature || {};
    current.by_feature[feature] = current.by_feature[feature] || {reserved: 0, accounted: 0};
    current.by_feature[feature].reserved = Math.max(0, Number(current.by_feature[feature].reserved || 0) - estimate);
    current.by_feature[feature].accounted = Number(current.by_feature[feature].accounted || 0) + cost;
    current.updated = Date.now() / 1000;
    saveLedger(path, current);
    return current;
  });
}

export function importRun(path: string, usage: {completed_accounted_usd?: number; accounted_or_reserved_usd?: number; budget_usd?: number}) {
  return withLock(path, () => {
    const current = existsSync(path) ? loadLedger(path) : emptyAccount();
    const accounted = Number(usage.completed_accounted_usd ?? usage.accounted_or_reserved_usd ?? 0);
    current.accounted_usd = Math.max(Number(current.accounted_usd || 0), accounted);
    if (usage.budget_usd) current.budget_usd = usage.budget_usd;
    current.updated = Date.now() / 1000;
    saveLedger(path, current);
    return current;
  });
}

export function addUsage(path: string, feature: string, tokens: number, rate = FIXTURE_RATE) {
  return settle(path, {tokens, feature, rate});
}
