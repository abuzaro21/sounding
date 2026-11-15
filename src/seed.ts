// A deterministic synthetic retailer ("Larkspur Outfitters"). Every name, email and address is invented; emails use
// the reserved example.test domain. The archetypes guarantee each consequence the demo depends on exists in every
// workspace, while the seed varies counts of ordinary history around them.
import type { Q } from './db.ts';
import { TABLES, type Table } from './schema.ts';

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const FIRST = ['Ada', 'Bram', 'Cleo', 'Dario', 'Edie', 'Femi', 'Greta', 'Hugo', 'Ines', 'Jonah', 'Kaia', 'Luca', 'Mira', 'Nils', 'Odette', 'Pavel', 'Quinn', 'Rosa', 'Soren', 'Tess', 'Uma', 'Viktor', 'Wren', 'Yara', 'Zane'];
const LAST = ['Abara', 'Brook', 'Castell', 'Dunmore', 'Ekwueme', 'Fairley', 'Gallo', 'Hartigan', 'Iqbal', 'Jarvik', 'Kestrel', 'Lindqvist', 'Moreau', 'Nakata', 'Okafor', 'Pell', 'Quarry', 'Ruiz', 'Sato', 'Thorne', 'Ueda', 'Vance', 'Whitlow', 'Yeboah'];
const CITIES = ['Aldermoor', 'Brackwater', 'Cindervale', 'Dunhollow', 'Eastmere', 'Fernick', 'Galloway Cross', 'Harrowgate'];
const PRODUCTS = [
  ['TNT-2P', 'Ridgeback 2P tent', 34900], ['BAG-35', 'Cirrus 35 L pack', 15900], ['SLP-08', 'Ember -8 °C sleeping bag', 21900],
  ['STV-TI', 'Titan micro stove', 6900], ['JKT-SH', 'Squall shell jacket', 18900], ['BTS-HK', 'Talus hiking boots', 16500],
  ['PAD-IN', 'Loft insulated pad', 9900], ['LMP-HD', 'Beacon headlamp', 4500], ['FLT-GR', 'Clearbrook water filter', 5400],
  ['POL-CF', 'Carbon trekking poles', 11900], ['MUG-TI', 'Titanium mug', 2900], ['MAP-SET', 'Highland map set', 3900],
] as const;

export type Archetype = 'active' | 'lapsing' | 'dormant_clean' | 'dormant_ancient' | 'dormant_retained' | 'dormant_unpaid'
  | 'dormant_subscribed' | 'dormant_shipping' | 'dormant_open_case';
/** How many dormant customers of each kind every workspace has (all inactive for 18+ months). */
export const DORMANT: Partial<Record<Archetype, number>> = {
  dormant_clean: 22, dormant_ancient: 6, dormant_retained: 10, dormant_unpaid: 3, dormant_subscribed: 3, dormant_shipping: 2, dormant_open_case: 2,
};

type Row = Record<string, unknown>;

export function generate(seed: number, now = Date.now()) {
  const r = rng(seed);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000 - int(0, 86_399) * 1000).toISOString();
  const rows: Record<Table, Row[]> = Object.fromEntries(TABLES.map((t) => [t, []])) as never;
  const n = { cus: 0, adr: 0, ord: 0, lin: 0, inv: 0, pay: 0, shp: 0, sub: 0, cas: 0 };
  let cleanSeen = 0;
  const id = (k: keyof typeof n) => `${k}_${String(++n[k]).padStart(4, '0')}`;

  rows.products = PRODUCTS.map(([sku, name, price], i) => ({ id: `prd_${String(i + 1).padStart(2, '0')}`, sku, name, price_cents: price, stock: int(20, 90), reserved: 0 }));
  rows.settings = [{ id: 'ledger_mirroring', enabled: false }];

  const order = (cus: string, daysAgo: number, status: string, invoice: 'paid' | 'open' | 'partial' | 'none', ship?: string) => {
    const o = id('ord'), lines = int(1, 3);
    let total = 0;
    for (let i = 0; i < lines; i++) {
      const p = pick(rows.products), qty = int(1, 2);
      total += (p.price_cents as number) * qty;
      rows.order_lines.push({ id: id('lin'), order_id: o, product_id: p.id, qty, unit_cents: p.price_cents });
      if (status === 'pending_payment' || status === 'processing') (p as { reserved: number }).reserved += qty;
    }
    rows.orders.push({ id: o, customer_id: cus, status, placed_at: at(daysAgo), total_cents: total, updated_at: at(Math.max(0, daysAgo - 2)) });
    if (invoice !== 'none') {
      const v = id('inv');
      rows.invoices.push({ id: v, order_id: o, number: `LO-${v.slice(4)}`, status: invoice === 'paid' ? 'paid' : 'open', amount_cents: total, issued_at: at(daysAgo) });
      if (invoice !== 'open') {
        const amount = invoice === 'paid' ? total : Math.round(total * 0.3);
        rows.payments.push({ id: id('pay'), invoice_id: v, amount_cents: amount, method: pick(['card', 'card', 'paypal', 'bank']), captured_at: at(daysAgo), provider_ref: `psp_${(r() * 1e12).toString(36).slice(0, 8)}` });
      }
    }
    if (ship) rows.shipments.push({ id: id('shp'), order_id: o, status: ship, carrier: pick(['Northline', 'Parcelwise', 'Kestrel Freight']), tracking: `TRK${int(100000, 999999)}` });
    return o;
  };
  const historic = (cus: string, minDays: number, maxDays: number) => order(cus, int(minDays, maxDays), 'delivered', 'paid', 'delivered');

  const customer = (kind: Archetype) => {
    const c = id('cus'), first = pick(FIRST), last = pick(LAST);
    const dormant = kind.startsWith('dormant');
    const lastActive = kind === 'active' ? int(0, 150) : kind === 'lapsing' ? int(250, 520) : int(560, 1300);
    rows.customers.push({
      id: c, name: `${first} ${last}`, email: `${first}.${last}.${n.cus}@example.test`.toLowerCase(),
      status: kind === 'active' ? 'active' : 'inactive', last_active_at: at(lastActive), created_at: at(lastActive + int(200, 900)),
      referred_by: null, loyalty_points: int(0, 2400),
    });
    rows.addresses.push({ id: id('adr'), customer_id: c, kind: 'shipping', line1: `${int(1, 220)} ${pick(['Mill', 'Quarry', 'Heath', 'Ferry', 'Pine'])} ${pick(['Lane', 'Road', 'Row'])}`, city: pick(CITIES), postcode: `LK${int(10, 99)} ${int(1, 9)}${pick(['AB', 'QT', 'RX', 'WE'])}` });
    const caseFor = (status: 'open' | 'closed', daysAgo: number) => rows.support_cases.push({ id: id('cas'), customer_id: c, subject: pick(['Zip failure on shell jacket', 'Refund question', 'Missing tent pegs', 'Delivery address change', 'Warranty claim: stove']), status, opened_at: at(daysAgo), updated_at: at(daysAgo - 1) });
    switch (kind) {
      case 'active': {
        for (let i = int(0, 4); i > 0; i--) historic(c, 20, 1000);
        if (r() < 0.25) order(c, int(1, 6), 'processing', 'paid', 'pending');
        if (r() < 0.22) rows.subscriptions.push({ id: id('sub'), customer_id: c, plan: pick(['Trail Club', 'Gear Care']), status: 'active', monthly_cents: pick([900, 1500]), renews_at: at(-int(1, 28)) });
        if (r() < 0.2) caseFor(r() < 0.5 ? 'open' : 'closed', int(1, 60));
        break;
      }
      case 'lapsing': historic(c, 260, 600); break;
      case 'dormant_clean': if (r() < 0.3 || cleanSeen++ < 2) caseFor('closed', lastActive + 10); break; // at least two: the reopened-case drift needs one
      case 'dormant_ancient': historic(c, 2950, 3300); break; // older than the 7-year retention period
      case 'dormant_retained': historic(c, 600, 1500); break;
      case 'dormant_unpaid': order(c, lastActive + 5, 'delivered', 'open', 'delivered'); break;
      case 'dormant_subscribed': rows.subscriptions.push({ id: id('sub'), customer_id: c, plan: 'Gear Care', status: 'active', monthly_cents: 900, renews_at: at(-int(1, 28)) }); break;
      case 'dormant_shipping': order(c, int(3, 9), 'processing', 'paid', 'pending'); break; // a back-order placed by phone
      case 'dormant_open_case': caseFor('open', int(2, 20)); break;
    }
    return c;
  };

  const active = Array.from({ length: 96 }, () => customer('active'));
  for (let i = 0; i < 10; i++) customer('lapsing');
  const dormant: Record<string, string[]> = {};
  for (const [k, count] of Object.entries(DORMANT)) dormant[k] = Array.from({ length: count }, () => customer(k as Archetype));
  // Referrals: active customers referred by dormant "clean" customers. Deleting the referrer edits these active rows.
  const byId = new Map(rows.customers.map((c) => [c.id, c]));
  for (let i = 0; i < 4; i++) byId.get(active[i * 7 + 3])!.referred_by = dormant.dormant_clean[i * 5];
  for (let i = 0; i < 6; i++) byId.get(active[40 + i * 3])!.referred_by = active[i];
  // Stale unpaid orders (for the second action): pending payment for 15–60 days. Two are partly paid, one already has a label.
  for (let i = 0; i < 12; i++) order(active[50 + i * 3], int(15, 60), 'pending_payment', i < 2 ? 'partial' : 'open', i === 2 ? 'pending' : undefined);
  for (let i = 0; i < 3; i++) order(active[10 + i], int(2, 6), 'pending_payment', 'open'); // recent: not stale
  return { rows, dormant, now };
}

/** Inserts a generated dataset into an (empty) workspace inside the caller's transaction. */
export async function insertSeed(q: Q, ws: string, rows: Record<Table, Row[]>) {
  for (const t of TABLES) {
    if (!rows[t].length) continue;
    await q(`insert into ${t} select * from jsonb_populate_recordset(null::${t}, $1::jsonb)`, [JSON.stringify(rows[t].map((x) => ({ workspace_id: ws, ...x })))]);
  }
}
