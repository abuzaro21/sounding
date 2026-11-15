// Records the film from the real app. Usage: node film/capture.ts   (run from the repository root, after npm run build)
// A fresh server runs against its own throwaway database (sim_film on the local Docker PostgreSQL); Playwright drives
// the UI as an operator would. Chrome's screencast saves every painted frame with its timestamp; film/assemble.ts turns
// them into video. A cursor overlay is drawn so viewers can follow the real pointer. Nothing in the app is mocked.
// The two closing cards are HTML: one shows the numbers in docs/evidence/eval.json, the other the logo animation.
import { chromium, type Locator, type Page } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { timeline } from './timeline.ts';

const PORT = 3388, BASE = `http://127.0.0.1:${PORT}`, CAP = 'film/capture';
const scenes = Object.fromEntries(timeline().map((s) => [s.id, s]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- server on a fresh, disposable database ----------
const psql = (sql: string) => execFileSync('docker', ['exec', 'doo-sim-pg', 'psql', '-U', 'postgres', '-q', '-c', sql]);
psql('drop database if exists sim_film'); psql('create database sim_film owner app');
const server = spawn(process.execPath, ['src/main.ts'], {
  env: { ...process.env, PORT: String(PORT), DATABASE_URL: 'postgres://app:app@127.0.0.1:55432/sim_film', NODE_ENV: 'development', SND_OUTBOX_HOLD_S: '600', SND_RELAXED_LIMITS: '1' }, stdio: 'ignore',
});
for (let i = 0; ; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } if (i > 120) throw new Error('server did not start'); await sleep(250); }

// ---------- pointer ----------
const CURSOR = `addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 14.8 L11.6 21.6 L14.6 20.3 L11.6 13.6 L17.8 13.6 Z" fill="#13212b" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-60px,-60px)' });
  document.body.appendChild(c);
  addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + (e.clientX - 4) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
  addEventListener('mousedown', (e) => {
    const r = document.createElement('div');
    Object.assign(r.style, { position: 'fixed', left: e.clientX - 18 + 'px', top: e.clientY - 18 + 'px', width: '36px', height: '36px', borderRadius: '50%', border: '2.5px solid #1d6fd6', zIndex: '2147483646', pointerEvents: 'none', transition: 'transform .5s ease-out, opacity .5s ease-out' });
    document.body.appendChild(r);
    requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scale(1.7)'; r.style.opacity = '0'; }));
    setTimeout(() => r.remove(), 600);
  }, true);
});`;
let mx = 720, my = 420;
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
async function glide(page: Page, x: number, y: number, ms = 550) {
  const x0 = mx, y0 = my, t0 = Date.now();
  for (let e = 0; e < ms; e = Date.now() - t0) { const k = ease(e / ms); await page.mouse.move(x0 + (x - x0) * k, y0 + (y - y0) * k); await sleep(16); }
  await page.mouse.move(x, y); mx = x; my = y;
}
async function box(l: Locator) { await l.waitFor({ state: 'visible', timeout: 30_000 }); return (await l.boundingBox())!; }
/** Smooth scroll so that the element's top sits `offset` px below the top of the viewport. */
async function scrollTo(page: Page, l: Locator | number, offset = 140, ms = 800) {
  const y = typeof l === 'number' ? l : (await box(l)).y + (await page.evaluate(() => scrollY)) - offset;
  await page.evaluate(([to, d]) => new Promise<void>((res) => {
    const y0 = scrollY, t0 = performance.now(), max = document.documentElement.scrollHeight - innerHeight, y1 = Math.max(0, Math.min(max, to));
    const f = (t: number) => { const k = Math.min(1, (t - t0) / d); const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; window.scrollTo(0, y0 + (y1 - y0) * e); if (k < 1) requestAnimationFrame(f); else res(); };
    requestAnimationFrame(f);
  }), [y, ms] as const);
}
async function inView(page: Page, l: Locator, offset = 260) {
  const b = await box(l);
  if (b.y < 70 || b.y + b.height > 810 - 70) await scrollTo(page, l, offset, 600);
}
async function hover(page: Page, l: Locator, ms = 550) { await inView(page, l); const b = await box(l); await glide(page, b.x + Math.min(b.width / 2, 160), b.y + b.height / 2, ms); }
async function click(page: Page, l: Locator, ms = 550) { await hover(page, l, ms); await sleep(110); await page.mouse.down(); await sleep(70); await page.mouse.up(); }

/** Chrome screencast of one page: every painted frame with its timestamp, plus the recording's start on the same clock. */
class Rec {
  frames: { f: string; ts: number }[] = []; t0 = 0; dir: string;
  cdp!: Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>>;
  page: Page; name: string;
  constructor(page: Page, name: string) { this.page = page; this.name = name; this.dir = `${CAP}/${name}`; }
  async start() {
    rmSync(this.dir, { recursive: true, force: true }); mkdirSync(this.dir, { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', (f) => {
      const file = `${String(this.frames.length).padStart(5, '0')}.jpg`;
      writeFileSync(`${this.dir}/${file}`, Buffer.from(f.data, 'base64'));
      this.frames.push({ f: file, ts: f.metadata.timestamp! });
      this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    this.t0 = Date.now() / 1000;
  }
  /** Waits until `sec` into the recording; reports actions that run late so the edit can be checked. */
  async at(sec: number) { const late = Date.now() / 1000 - this.t0 - sec; if (late > 0.25) console.warn(`  ${this.name}: ${late.toFixed(2)} s late at ${sec.toFixed(2)}`); else await sleep(Math.max(0, (this.t0 + sec) * 1000 - Date.now())); }
  async stop(len: number) {
    await this.at(len);
    await this.cdp.send('Page.stopScreencast'); await sleep(150);
    writeFileSync(`${this.dir}/frames.json`, JSON.stringify({ t0: this.t0, len, frames: this.frames }));
    console.log(`${this.name}: ${this.frames.length} frames for ${len.toFixed(2)} s`);
  }
}

// ---------- cards ----------
const assets = readdirSync('public/assets');
// Inlined: a card is set on about:blank, which cannot load fonts from the server's origin.
const font = (re: RegExp) => `data:font/woff2;base64,${readFileSync(`public/assets/${assets.find((f) => re.test(f))}`).toString('base64')}`;
const FONTS = `@font-face { font-family: Plex; src: url(${font(/ibm-plex-sans-latin-400-normal/)}) format('woff2'); font-weight: 400; }
@font-face { font-family: Plex; src: url(${font(/ibm-plex-sans-latin-600-normal/)}) format('woff2'); font-weight: 600; }
@font-face { font-family: PlexMono; src: url(${font(/ibm-plex-mono-latin-400-normal/)}) format('woff2'); }`;
const SEA = 'background: linear-gradient(180deg, #164e5d 0%, #0e3642 45%, #08222b 100%); color: #e7f2f3;';

function evidenceCard() {
  const e = JSON.parse(readFileSync('docs/evidence/eval.json', 'utf8'));
  const c = e.effect_set_on_commit, t = e.tallies;
  const drift = Object.entries(t).filter(([k]) => k.startsWith('drift_injected:')).reduce((n, [, v]) => n + Number(v), 0);
  const caught = Object.entries(t).filter(([k]) => k.startsWith('caught_by:')).reduce((n, [, v]) => n + Number(v), 0);
  const rows = [
    [`${c.predicted_and_actual} / ${c.predicted_and_actual + c.actual_not_predicted}`, 'committed row changes predicted exactly', `precision ${c.precision}, recall ${c.recall}`],
    [`${caught} / ${drift}`, 'drifts after approval caught before commit', 'refused or rolled back, state re-verified'],
    [String(t.false_safe_commit_under_drift), 'unsafe commits', `${t.double_execution} double executions · ${t.replay_refused} replays refused`],
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
html, body { margin: 0; height: 100%; overflow: hidden; } body { ${SEA} font-family: Plex, sans-serif; display: grid; align-content: center; padding: 0 120px; box-sizing: border-box; }
.eyebrow { font-family: PlexMono; font-size: 17px; letter-spacing: .12em; text-transform: uppercase; color: #a9c3c8; margin: 0 0 14px; animation: in .6s ease-out both; }
h1 { font-weight: 600; font-size: 46px; margin: 0 0 54px; letter-spacing: -.01em; animation: in .6s .15s ease-out both; }
.rows { display: grid; gap: 30px; } .row { display: grid; grid-template-columns: 340px 1fr; align-items: baseline; gap: 36px; opacity: 0; animation: in .55s ease-out both; }
.row:nth-child(1) { animation-delay: .9s } .row:nth-child(2) { animation-delay: 3.0s } .row:nth-child(3) { animation-delay: 5.4s }
.n { font-family: PlexMono; font-size: 64px; color: #6fc3b8; text-align: right; white-space: nowrap; letter-spacing: -0.04em; } .l { font-size: 30px; font-weight: 600; } .d { display: block; font-family: PlexMono; font-size: 17px; color: #a9c3c8; margin-top: 6px; font-weight: 400; }
.src { position: absolute; left: 120px; bottom: 120px; font-family: PlexMono; font-size: 15px; color: #a9c3c8; opacity: 0; animation: in .6s 6.4s ease-out both; }
@keyframes in { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: none } }
</style></head><body><p class="eyebrow">Measured, not claimed</p><h1>${e.seeds} seeded scenarios against real PostgreSQL</h1>
<div class="rows">${rows.map(([n, l, d]) => `<div class="row"><div class="n">${n}</div><div class="l">${l}<span class="d">${d}</span></div></div>`).join('')}</div>
<div class="src">docs/evidence/eval.json · npm run eval</div></body></html>`;
}

function endCard() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
html, body { margin: 0; height: 100%; overflow: hidden; } body { ${SEA} font-family: Plex, sans-serif; display: grid; place-items: center; }
.wrap { display: grid; justify-items: center; gap: 34px; } svg { width: 230px; height: 230px; color: #e7f2f3; overflow: visible; }
.ring { stroke-dasharray: 92; stroke-dashoffset: 92; animation: draw 1.1s .2s cubic-bezier(.6,0,.3,1) forwards; }
.wave { stroke-dasharray: 32; stroke-dashoffset: 32; animation: draw .9s .9s ease-out forwards; }
.deep { opacity: 0; animation: fade .8s 1.4s ease-out forwards; }
.line { stroke-dasharray: 18; stroke-dashoffset: 18; animation: draw .7s 1.6s ease-in forwards; }
.bob { opacity: 0; transform: translateY(-10px); animation: drop .5s 2.2s cubic-bezier(.3,1.6,.5,1) forwards; }
.name { font-weight: 600; font-size: 74px; letter-spacing: .32em; margin-right: -.32em; opacity: 0; animation: up .8s 2.3s ease-out forwards; }
.tag { font-size: 30px; color: #a9c3c8; opacity: 0; animation: up .8s 2.8s ease-out forwards; }
@keyframes draw { to { stroke-dashoffset: 0 } } @keyframes fade { to { opacity: .16 } } @keyframes drop { to { opacity: 1; transform: none } }
@keyframes up { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: none } }
</style></head><body><div class="wrap">
<svg viewBox="0 0 32 32" aria-hidden="true">
<circle class="ring" cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" stroke-width="1.6" pathLength="92" transform="rotate(-90 16 16)"/>
<path class="wave" d="M2.5 15 Q 6 12.5 9.5 15 T 16.5 15 T 23.5 15 T 29.5 15" fill="none" stroke="#6fc3b8" stroke-width="1.6" stroke-linecap="round" pathLength="32"/>
<path class="deep" d="M2.6 17 A 14 14 0 0 0 29.4 17 Z" fill="#6fc3b8"/>
<line class="line" x1="16" y1="5" x2="16" y2="22.5" stroke="currentColor" stroke-width="1.3" pathLength="18"/>
<path class="bob" d="M13.6 22.5 h4.8 l-1 4.2 h-2.8 Z" fill="currentColor"/>
</svg><div class="name">SOUNDING</div><div class="tag">See the consequences before they become real.</div></div></body></html>`;
}

// ---------- film ----------
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3, colorScheme: 'light', reducedMotion: 'no-preference' });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.getByRole('heading', { name: 'An agent wants to change your data.' }).waitFor({ timeout: 60_000 });
  await page.mouse.move(mx, my); await sleep(800);

  const rec = new Rec(page, 'app');
  const S = (id: string, off: number) => rec.at(scenes[id].start + off);
  await rec.start();
  const verdict = (re: RegExp) => page.getByRole('heading', { name: re });

  // 1. Intent: the operator picks the request.
  await S('intent', 1.0); await hover(page, page.getByRole('button', { name: 'Remove inactive customer accounts older than 18 months' }), 900);
  await S('intent', 4.2); await click(page, page.getByRole('button', { name: 'Remove inactive customer accounts older than 18 months' }), 200);
  await verdict(/Blocked/).waitFor();

  // 2. Measure: down through the waterline.
  await S('measure', 0.8); await hover(page, page.getByRole('button', { name: /^customers: \d+ deleted/ }).first(), 700);
  await S('measure', 4.2); await scrollTo(page, 300, 0, 1800);
  await S('measure', 6.8); await hover(page, page.getByRole('button', { name: /^orders: \d+ deleted/ }), 600);
  await S('measure', 9.6); await hover(page, page.getByRole('button', { name: /^support cases: \d+ changed/ }), 600);
  await S('measure', 12.6); await hover(page, page.getByRole('button', { name: /^outgoing messages/ }), 700);

  // 3. Blocked: the findings, then the agent narrows.
  await S('blocked', 0.2); await scrollTo(page, 150, 0, 900);
  await S('blocked', 1.2); await hover(page, page.locator('li.finding').first(), 700);
  await S('blocked', 3.6); await hover(page, page.locator('li.finding').nth(1), 600);
  await S('blocked', 6.3); await click(page, page.getByRole('button', { name: 'Let the agent narrow it' }), 600);
  await verdict(/Safe to approve/).waitFor();
  await S('blocked', 8.8); await scrollTo(page, 0, 0, 900);

  // 4. Approve: a binding, not a yes.
  await S('approve', 0.6); await hover(page, verdict(/Safe to approve/), 600);
  await S('approve', 2.4); await click(page, page.getByRole('button', { name: /^Approve \d+ changes$/ }), 600);
  await page.getByRole('heading', { name: 'Approved, not yet executed' }).waitFor();
  await S('approve', 3.6); await scrollTo(page, page.getByRole('heading', { name: 'Approved, not yet executed' }), 90, 900);
  await S('approve', 4.8); await hover(page, page.getByText('Effect digest', { exact: true }).first(), 600);
  await S('approve', 6.6); await hover(page, page.getByText('One-time nonce'), 600);

  // 5. Drift, then execute anyway.
  await S('drift', 0.3); await scrollTo(page, page.getByRole('button', { name: /phones in an order/ }), 520, 800);
  await S('drift', 1.4); await click(page, page.getByRole('button', { name: /phones in an order/ }), 600);
  await page.getByText(/just phoned in an order/).waitFor();
  await S('drift', 2.8); await click(page, page.getByRole('button', { name: 'Execute' }), 600);
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await S('drift', 6.4); await hover(page, dialog.getByText('Not in what you approved'), 600);

  // 6. Rollback proof.
  await S('rollback', 0.6); await hover(page, dialog.getByText(/Rolled back before commit/), 700);

  // 7. Re-simulate on current data, narrow, approve, execute.
  await S('commit', 0.1); await click(page, dialog.getByRole('button', { name: 'Simulate again on current data' }), 300);
  await verdict(/Blocked/).waitFor();
  await click(page, page.getByRole('button', { name: 'Let the agent narrow it' }), 300);
  await verdict(/Safe to approve/).waitFor();
  await click(page, page.getByRole('button', { name: /^Approve \d+ changes$/ }), 300);
  await click(page, page.getByRole('button', { name: 'Execute' }), 300);
  await page.getByRole('heading', { name: 'Committed and verified' }).waitFor();
  await scrollTo(page, page.getByRole('heading', { name: 'Committed and verified' }), 90, 700);

  // 8. Restore through the same gate.
  await S('restore', 0.2); await click(page, page.getByRole('button', { name: 'Plan a restoration' }), 500);
  await verdict(/Safe to approve/).waitFor();
  await click(page, page.getByRole('button', { name: /^Approve \d+ changes$/ }), 450);
  await click(page, page.getByRole('button', { name: 'Execute' }), 500);
  await page.getByRole('heading', { name: 'Committed and verified' }).waitFor();
  await S('restore', 5.2); await hover(page, page.getByText(/cancelled before dispatch/), 700);
  await rec.stop(scenes.evidence.start);

  // 9–10. Cards.
  for (const [id, html] of [['evidence', evidenceCard()], ['end', endCard()]] as const) {
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3 })).newPage();
    await p.setContent('<body style="margin:0;background:#0e3642"></body>');
    const r = new Rec(p, id);
    await r.start();
    await p.setContent(html, { waitUntil: 'load' });
    await r.stop(scenes[id].len);
    writeFileSync(`${CAP}/${id}.html`, html);
  }
} finally {
  await browser.close();
  server.kill();
}
