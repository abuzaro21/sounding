// Shared by capture and assembly: where each scene and narration segment sits in the film.
import { readFileSync } from 'node:fs';

export const TOTAL = 89.9, LEAD = 0.4, GAP = 0.5, TAIL = 0.5;
/** Extra seconds after a scene's narration: real simulations and executions take longer than their narration (taken from the end card's slack). */
const HOLD: Record<string, number> = { commit: 2.3, restore: 1.8 };
export const SCENES = ['intent', 'measure', 'blocked', 'approve', 'drift', 'rollback', 'commit', 'restore', 'evidence', 'end'].map((id) => ({ id, segs: [id] }));

export type Scene = { id: string; start: number; len: number; segs: { id: string; at: number; d: number }[] };

export function timeline(d: Record<string, number> = JSON.parse(readFileSync('film/tts/durations.json', 'utf8'))): Scene[] {
  let t = 0;
  return SCENES.map((s) => {
    let r = LEAD;
    const segs = s.segs.map((id) => { const x = { id, at: r, d: d[id] }; r += d[id] + GAP; return x; });
    let len = r - GAP + TAIL + (HOLD[s.id] ?? 0);
    if (s.id === 'end') len = Math.max(len, TOTAL - t);
    const out = { id: s.id, start: t, len: Math.round(len * 1000) / 1000, segs };
    t += out.len;
    return out;
  });
}
