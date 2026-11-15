// Per-IP token buckets and client-address resolution behind a known number of trusted proxies (from the RollCue codebase).
import type http from 'node:http';

const MAX_BUCKETS = 10_000;
/** Per-IP token buckets. */
export class Limiter {
  #b = new Map<string, { t: number; n: number }>();
  rate: number; burst: number;
  constructor(rate: number, burst: number) { this.rate = rate; this.burst = burst; }
  #swept = -Infinity;
  take(key: string, now = Date.now()) {
    if (!this.#b.has(key) && this.#b.size >= MAX_BUCKETS) {
      // Memory cap without resetting anyone's budget (Codex R8-4): a bucket that has refilled is the same as no bucket,
      // so only those are dropped. While every tracked bucket is still refilling, unseen keys share one bucket.
      if (now - this.#swept >= 1000) { this.#swept = now; for (const [k, b] of this.#b) if (b.n + ((now - b.t) / 1000) * this.rate >= this.burst) this.#b.delete(k); }
      if (this.#b.size >= MAX_BUCKETS) key = 'overflow';
    }
    const b = this.#b.get(key) ?? { t: now, n: this.burst };
    b.n = Math.min(this.burst, b.n + ((now - b.t) / 1000) * this.rate); b.t = now;
    const ok = b.n >= 1;
    if (ok) b.n -= 1;
    this.#b.set(key, b);
    return ok;
  }
}

/** The address a limit applies to. IPv4 as is; IPv6 by its /64, which one subscriber usually holds whole. */
/** Every spelling of one address gives one key; anything unparseable shares the key "invalid" (Codex R8-5). */
export function addressKey(ip: string) {
  const quad = (x: string) => { const o = x.split('.').map(Number); return o.length === 4 && x.split('.').every((p) => /^\d{1,3}$/.test(p)) && o.every((n) => n <= 255) ? o : null; };
  let s = ip.trim().toLowerCase().split('%')[0];
  if (!s.includes(':')) return quad(s)?.join('.') ?? 'invalid';
  const mixed = /^(.*:)(\d*\.[\d.]*)$/.exec(s); // a trailing dotted quad is the last two groups
  if (mixed) { const o = quad(mixed[2]); if (!o) return 'invalid'; s = `${mixed[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`; }
  const [head, tail, extra] = s.split('::');
  if (extra !== undefined) return 'invalid';
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const g = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  if (g.length !== 8 || !g.every((x) => /^[0-9a-f]{1,4}$/.test(x))) return 'invalid';
  const n = g.map((x) => parseInt(x, 16));
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) return [n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join('.'); // IPv4-mapped
  return `${n.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

export function clientIp(req: http.IncomingMessage, hops: number): string {
  if (hops <= 0) return addressKey(req.socket.remoteAddress ?? 'unknown');
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // With N trusted proxies the client is the Nth address from the right; anything further left is client-controlled.
  // A shorter chain did not come through those proxies: it shares one bucket instead of getting the forwarding
  // proxy's socket address, which differs per proxy connection and would multiply the budget.
  return xff.length >= hops ? addressKey(xff[xff.length - hops]) : 'short-chain';
}
