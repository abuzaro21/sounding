// The agent. Deterministic and bounded: it compiles a business request into an allowlisted Spec, states what it
// expects to happen (it only knows the table it targets, as an agent writing `DELETE ... WHERE` would), and after a
// blocked simulation it narrows the scope using the evidence the simulation measured. It can propose; it cannot approve.
import { LIMITS, PlanError, type Spec, type TemplateName } from './templates.ts';
import type { PolicyResult } from './policy.ts';

export const AGENT = 'agent:planner-v1';

export type Compiled = { template: Exclude<TemplateName, 'restore_execution'>; params: Spec['params']; reading: string };

const NUM_WORDS: Record<string, number> = { six: 6, twelve: 12, eighteen: 18, two: 2, three: 3, four: 4, five: 5, thirty: 30, sixty: 60, ninety: 90, fourteen: 14, seven: 7, ten: 10 };
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUM_WORDS[s.toLowerCase()]);

export const EXAMPLES = [
  'Remove inactive customer accounts older than 18 months',
  'Cancel unpaid orders older than 14 days',
];

/** Natural language to a structured action. Only these two shapes compile; everything else is refused, not guessed. */
export function compile(intent: string): Compiled {
  const t = intent.trim().replace(/\s+/g, ' ');
  if (t.length > 200) throw new PlanError('Requests are limited to 200 characters.');
  // Plain words only, and nothing after the period: text the grammar did not read must not ride along unnoticed.
  if (!/^[A-Za-z0-9 ,.'’!?-]+$/.test(t)) throw new PlanError('Requests are plain words: letters, numbers and basic punctuation.');
  const purge = /\b(remove|delete|purge|erase|clean ?up)\b.*\b(inactive|dormant)\b.*\bcustomers?\b.*?\b(?:older than|inactive for|for (?:over|more than)|more than|over)\s+(\d+|[a-z]+)\s*(months?|years?)[.!]?$/i.exec(t);
  if (purge) {
    let months = num(purge[3]);
    if (months === undefined) throw new PlanError(`Could not read the period "${purge[3]}".`);
    if (/^year/i.test(purge[4])) months *= 12;
    if (months < LIMITS.months[0] || months > LIMITS.months[1]) throw new PlanError(`The inactivity period must be ${LIMITS.months[0]}–${LIMITS.months[1]} months.`);
    return { template: 'purge_inactive_customers', params: { months }, reading: `delete customers with status "inactive" whose last activity is more than ${months} months ago` };
  }
  const cancel = /\bcancel\b.*\b(stale|unpaid|pending)\b.*\borders?\b.*?\b(?:older than|over|more than|for more than)\s+(\d+|[a-z]+)\s*(days?|weeks?)[.!]?$/i.exec(t);
  if (cancel) {
    let days = num(cancel[2]);
    if (days === undefined) throw new PlanError(`Could not read the period "${cancel[2]}".`);
    if (/^week/i.test(cancel[3])) days *= 7;
    if (days < LIMITS.days[0] || days > LIMITS.days[1]) throw new PlanError(`The age must be ${LIMITS.days[0]}–${LIMITS.days[1]} days.`);
    return { template: 'cancel_stale_orders', params: { days }, reading: `cancel orders still awaiting payment more than ${days} days after they were placed` };
  }
  throw new PlanError(`Not an allowlisted action. SOUNDING can plan: "${EXAMPLES[0]}" or "${EXAMPLES[1]}" (any period).`);
}

/** What the agent believes will happen before anything is simulated. Deliberately the naive, single-table view. */
export function expectation(spec: Spec) {
  const table = spec.template === 'cancel_stale_orders' ? 'orders' : 'customers';
  const verb = spec.template === 'cancel_stale_orders' ? 'update' : spec.template === 'restore_execution' ? 'restore' : 'delete';
  return { table, rows: spec.target_ids.length, statement: `${verb} ${spec.target_ids.length} rows in ${table}` };
}

/**
 * Narrow a blocked plan. Excludes exactly the targets the simulation attributed blocking findings to, and explains why
 * in terms of the measured rows. Returns null when narrowing cannot help (the problem is not specific targets).
 */
export function revise(spec: Spec, policy: PolicyResult): { exclude: string[]; rationale: string } | null {
  if (spec.template === 'restore_execution') return null;
  const blocking = policy.findings.filter((f) => f.severity === 'block');
  if (!blocking.length || blocking.some((f) => !f.roots.length && f.rule !== 'TARGET_DRIFT')) return null;
  const drift = blocking.find((f) => f.rule === 'TARGET_DRIFT');
  const roots = new Set(blocking.filter((f) => f.rule !== 'TARGET_DRIFT').flatMap((f) => f.roots));
  if (drift) for (const r of drift.roots) roots.add(r); // targets that no longer qualify are dropped too
  const kept = spec.target_ids.filter((id) => !roots.has(id));
  if (!kept.length) return null;
  const why = blocking.filter((f) => f.rule !== 'TARGET_DRIFT').map((f) => `${f.roots.length} for ${f.rule.toLowerCase().replace(/_/g, ' ')} (${f.rows.length} row${f.rows.length === 1 ? '' : 's'})`);
  if (drift) why.push(`${drift.roots.length} that no longer match`);
  const noun = spec.template === 'cancel_stale_orders' ? 'orders' : 'customers';
  return {
    exclude: [...new Set([...spec.exclude, ...roots])].sort(),
    rationale: `The dry run showed my plan would break policy. I am excluding ${roots.size} ${noun}: ${why.join('; ')}. The remaining ${kept.length} must be simulated again before anyone can approve them.`,
  };
}
