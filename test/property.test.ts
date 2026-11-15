// G16: invariants over randomised scopes and drifts (seeds outside the published eval run), through the real gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, score } from '../scripts/eval.ts';
import type { Effect } from '../src/effects.ts';
import { URL } from './helpers.ts';

test('across random scopes and drifts: exact prediction on commit, no false-safe commit, no leaked side effect', async () => {
  const r = await evaluate(URL, [101, 102, 103, 104, 105, 106, 107, 108]);
  const t = r.tallies as Record<string, number>;
  assert.equal(r.effect_set_on_commit.precision, 1);
  assert.equal(r.effect_set_on_commit.recall, 1);
  for (const k of ['side_effects_escaping_simulation', 'false_safe_commit_under_drift', 'double_execution', 'rollback_left_changes', 'replay_executed']) assert.equal(t[k], 0, k);
  assert.equal(t.concurrent_duplicate_refused, 8);
  assert.equal(t.replay_refused, 8);
  const committed = Object.entries(t).filter(([k]) => /^outcome:.*:committed$/.test(k)).reduce((n, [, v]) => n + v, 0);
  assert.equal(t['restore:committed'] ?? 0, committed, 'every committed action in the run was restored');
});

test('scoring: a same-key effect with a different image is a miss on both sides (Codex R2-4)', () => {
  const e = (amount: number): Effect => ({ key: 'outbox:ob_1:INSERT#1', seq: 1, tbl: 'outbox', op: 'INSERT', id: 'ob_1', cause: 'trigger', after: { topic: 'payments.refund.request', payload: { amount_cents: amount } } });
  assert.deepEqual(score([e(100)], [e(100)]), { tp: 1, fp: 0, fn: 0 });
  assert.deepEqual(score([e(100)], [e(250)]), { tp: 0, fp: 1, fn: 1 });
  assert.deepEqual(score([e(100)], []), { tp: 0, fp: 1, fn: 0 }, 'predicted but did not happen: false positive');
  assert.deepEqual(score([], [e(100)]), { tp: 0, fp: 0, fn: 1 }, 'happened unpredicted: false negative');
});
