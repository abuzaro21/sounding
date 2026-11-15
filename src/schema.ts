// The database SOUNDING operates on: a fictional retailer's tables, with the foreign-key actions and triggers of a real
// (imperfect) legacy schema, plus the capture journal that measures every row change inside a transaction.
// Applied idempotently at start-up. Everything business-side is keyed (workspace_id, id) and row-level secured.

/** Business tables, parent-first. Restoration inserts in this order; the capture trigger must exist on every one. */
export const TABLES = [
  'customers', 'addresses', 'products', 'orders', 'order_lines', 'invoices', 'payments', 'shipments',
  'subscriptions', 'support_cases', 'settings', 'ledger_entries', 'outbox',
] as const;
export type Table = (typeof TABLES)[number];

/** Bookkeeping tables. Row-level secured like the business tables; they must carry no triggers (see schemaFingerprint). */
export const CONTROL = ['deliveries', 'change_log', 'actions', 'simulations', 'approvals', 'executions', 'audit'] as const;

/** Columns whose value legitimately differs between two runs of the same action (clock-derived). Excluded from effect digests. */
export const VOLATILE: Partial<Record<Table, string[]>> = {
  orders: ['updated_at'], support_cases: ['updated_at'], outbox: ['created_at', 'dispatched_at'], ledger_entries: ['created_at'],
};

const RLS = (t: string) => `
alter table ${t} enable row level security;
alter table ${t} force row level security;
drop policy if exists ws_isolation on ${t};
create policy ws_isolation on ${t} using (workspace_id = current_setting('snd.ws', true) or current_setting('snd.ws', true) = '*')
  with check (workspace_id = current_setting('snd.ws', true) or current_setting('snd.ws', true) = '*')`;

const CAPTURE = (t: string) => `
drop trigger if exists zzz_capture on ${t};
create trigger zzz_capture after insert or update or delete on ${t} for each row execute function snd_capture();
drop trigger if exists zzz_no_truncate on ${t};
create trigger zzz_no_truncate before truncate on ${t} for each statement execute function snd_no_truncate()`;

export const DDL = `
create table if not exists workspaces (
  id text primary key,
  token_hash text not null unique,
  seed int not null,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
-- History quota, reserved atomically before each write (Codex R9-4, R10-2). Reset sets it back to zero.
alter table workspaces add column if not exists used_sims int not null default 0, add column if not exists used_acts int not null default 0,
  add column if not exists used_drifts int not null default 0;

create table if not exists customers (
  workspace_id text not null references workspaces(id) on delete cascade,
  id text not null,
  name text not null,
  email text not null,
  status text not null check (status in ('active','inactive')),
  last_active_at timestamptz not null,
  created_at timestamptz not null,
  referred_by text,
  loyalty_points int not null default 0,
  primary key (workspace_id, id),
  unique (workspace_id, email),
  foreign key (workspace_id, referred_by) references customers(workspace_id, id) on delete set null (referred_by)
);
create table if not exists addresses (
  workspace_id text not null, id text not null, customer_id text not null,
  kind text not null, line1 text not null, city text not null, postcode text not null,
  primary key (workspace_id, id),
  foreign key (workspace_id, customer_id) references customers(workspace_id, id) on delete cascade
);
create table if not exists products (
  workspace_id text not null references workspaces(id) on delete cascade, id text not null,
  sku text not null, name text not null, price_cents int not null, stock int not null, reserved int not null default 0,
  primary key (workspace_id, id)
);
create table if not exists orders (
  workspace_id text not null, id text not null, customer_id text not null,
  status text not null check (status in ('pending_payment','processing','shipped','delivered','cancelled')),
  placed_at timestamptz not null, total_cents int not null, updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, customer_id) references customers(workspace_id, id) on delete cascade
);
create table if not exists order_lines (
  workspace_id text not null, id text not null, order_id text not null, product_id text not null,
  qty int not null, unit_cents int not null,
  primary key (workspace_id, id),
  foreign key (workspace_id, order_id) references orders(workspace_id, id) on delete cascade,
  foreign key (workspace_id, product_id) references products(workspace_id, id) deferrable initially deferred -- checked at commit, so deleting a whole workspace cannot trip on cascade order
);
create table if not exists invoices (
  workspace_id text not null, id text not null, order_id text not null, number text not null,
  status text not null check (status in ('open','paid','void')), amount_cents int not null, issued_at timestamptz not null,
  primary key (workspace_id, id),
  foreign key (workspace_id, order_id) references orders(workspace_id, id) on delete cascade
);
create table if not exists payments (
  workspace_id text not null, id text not null, invoice_id text not null,
  amount_cents int not null, method text not null, captured_at timestamptz not null, provider_ref text not null,
  primary key (workspace_id, id),
  foreign key (workspace_id, invoice_id) references invoices(workspace_id, id) on delete cascade
);
create table if not exists shipments (
  workspace_id text not null, id text not null, order_id text not null,
  status text not null check (status in ('pending','in_transit','delivered','voided')), carrier text not null, tracking text not null,
  primary key (workspace_id, id),
  foreign key (workspace_id, order_id) references orders(workspace_id, id) on delete cascade
);
create table if not exists subscriptions (
  workspace_id text not null, id text not null, customer_id text not null,
  plan text not null, status text not null check (status in ('active','cancelled')), monthly_cents int not null, renews_at timestamptz not null,
  primary key (workspace_id, id),
  foreign key (workspace_id, customer_id) references customers(workspace_id, id) on delete cascade
);
create table if not exists support_cases (
  -- Own workspace FK: the customer FK only nulls the reference, so without this a deleted workspace would leave its cases behind.
  workspace_id text not null references workspaces(id) on delete cascade, id text not null, customer_id text,
  subject text not null, status text not null check (status in ('open','closed')), opened_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, customer_id) references customers(workspace_id, id) on delete set null (customer_id)
);
-- Business configuration that triggers read. Not part of any action's target set.
create table if not exists settings (
  workspace_id text not null references workspaces(id) on delete cascade, id text not null, enabled boolean not null,
  primary key (workspace_id, id)
);
create table if not exists ledger_entries (
  workspace_id text not null references workspaces(id) on delete cascade, id text not null,
  kind text not null, ref text not null, amount_cents int not null, created_at timestamptz not null default now(),
  primary key (workspace_id, id)
);
-- Messages to external providers. Written only inside business transactions; dispatched only after commit.
create table if not exists outbox (
  workspace_id text not null references workspaces(id) on delete cascade, id text not null,
  topic text not null, aggregate text not null, payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','dispatched','cancelled')),
  created_at timestamptz not null default now(), dispatched_at timestamptz,
  primary key (workspace_id, id)
);
-- The outside world: what fictional providers have received. Written by the dispatcher only.
create table if not exists deliveries (
  workspace_id text not null references workspaces(id) on delete cascade, outbox_id text not null,
  provider text not null, topic text not null, payload jsonb not null, delivered_at timestamptz not null default now(),
  primary key (workspace_id, outbox_id)
);

-- The capture journal. Rows exist only inside the transaction that wrote them: simulation rolls them back,
-- execution copies them into its receipt and deletes them before commit.
create table if not exists change_log (
  capture_id text not null, seq int not null, workspace_id text not null,
  tbl text not null, op text not null, old_row jsonb, new_row jsonb,
  primary key (capture_id, seq)
);

-- Control plane: proposals, simulations, approvals, executions and an audit chain, all per workspace.
create table if not exists actions (
  id text primary key, workspace_id text not null references workspaces(id) on delete cascade,
  parent_id text, origin text not null, intent text not null, spec jsonb not null, spec_hash text not null,
  expectation jsonb not null, rationale text, status text not null default 'proposed', created_at timestamptz not null default now(),
  unique (workspace_id, id)
);
-- Control-plane references are tenant-qualified, like the business tables: a record can only point within its workspace.
create table if not exists simulations (
  id text primary key, workspace_id text not null references workspaces(id) on delete cascade,
  action_id text not null, spec_hash text not null,
  schema_fp text not null, row_versions jsonb not null, effects jsonb not null, effect_digest text not null,
  report jsonb not null, verdict text not null, durable jsonb not null, created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, action_id) references actions(workspace_id, id) on delete cascade
);
create table if not exists approvals (
  id text primary key, workspace_id text not null references workspaces(id) on delete cascade,
  simulation_id text not null, operator text not null,
  binding jsonb not null, binding_hash text not null, nonce text not null unique,
  status text not null check (status in ('approved','executing','consumed','failed','rejected')),
  expires_at timestamptz not null, created_at timestamptz not null default now(), outcome text,
  unique (workspace_id, id),
  foreign key (workspace_id, simulation_id) references simulations(workspace_id, id) on delete cascade
);
-- One approval per simulation, a failed one included: after a refusal or rollback, only a new simulation can be approved.
-- That also bounds approvals, and so executions, by the simulation quota (Codex R9-4).
drop index if exists approvals_one_live;
create unique index if not exists approvals_one_per_simulation on approvals(simulation_id) where status <> 'rejected';
create table if not exists executions (
  id text primary key, workspace_id text not null references workspaces(id) on delete cascade,
  approval_id text not null unique, simulation_id text not null, action_id text not null,
  status text not null check (status in ('committed','rolled_back','refused')),
  receipt jsonb not null, recovery jsonb, recovery_status text, recovery_expires_at timestamptz,
  created_at timestamptz not null default now(),
  -- One terminal receipt per approval: two processes cannot both record an outcome for it.
  foreign key (workspace_id, approval_id) references approvals(workspace_id, id) on delete cascade,
  foreign key (workspace_id, simulation_id) references simulations(workspace_id, id) on delete cascade,
  foreign key (workspace_id, action_id) references actions(workspace_id, id) on delete cascade
);
create table if not exists audit (
  workspace_id text not null references workspaces(id) on delete cascade, seq int not null,
  at timestamptz not null default now(), type text not null, data jsonb not null, prev_hash text not null, hash text not null,
  primary key (workspace_id, seq)
);

-- Deterministic ids for rows that triggers create, derived from the action being simulated or executed, so the same action
-- yields the same keys in its dry run and its execution. Outside an action (ordinary business writes) the id is random.
create or replace function snd_id(prefix text, parts text) returns text language sql volatile as $$
  select prefix || '_' || substr(md5(coalesce(nullif(current_setting('snd.action', true), ''), gen_random_uuid()::text) || '|' || parts), 1, 16)
$$;
-- A workspace being deleted (reset, expiry) cascades through business tables; it has no business effects left to emit.
create or replace function snd_emit(ws text, topic text, agg text, payload jsonb) returns void language sql as $$
  insert into outbox (workspace_id, id, topic, aggregate, payload)
  select ws, snd_id('ob', topic || '|' || agg), topic, agg, payload where exists (select 1 from workspaces w where w.id = ws)
$$;

-- Measurement: one journal row per row change, only in transactions that set snd.capture. Cascaded and trigger-made
-- changes fire this trigger on their own tables, so they are recorded like direct ones.
create or replace function snd_capture() returns trigger language plpgsql as $$
declare c text := current_setting('snd.capture', true); n int;
begin
  if c is null or c = '' then return null; end if;
  n := coalesce(nullif(current_setting('snd.capture_seq', true), ''), '0')::int + 1;
  perform set_config('snd.capture_seq', n::text, true);
  if tg_op = 'DELETE' then
    insert into change_log values (c, n, old.workspace_id, tg_table_name, tg_op, to_jsonb(old), null);
  elsif tg_op = 'UPDATE' then
    insert into change_log values (c, n, new.workspace_id, tg_table_name, tg_op, to_jsonb(old), to_jsonb(new));
  else
    insert into change_log values (c, n, new.workspace_id, tg_table_name, tg_op, null, to_jsonb(new));
  end if;
  return null;
end $$;
create or replace function snd_no_truncate() returns trigger language plpgsql as $$
begin raise exception 'TRUNCATE is not permitted on business tables'; end $$;

create or replace function snd_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- Business behaviour (the "undertow"): each is ordinary trigger logic a real retailer might have.
create or replace function snd_customer_erased() returns trigger language plpgsql as $$
begin
  perform snd_emit(old.workspace_id, 'crm.contact.erase', old.id, jsonb_build_object('customer', old.id, 'email', old.email));
  return null;
end $$;
create or replace function snd_subscription_gone() returns trigger language plpgsql as $$
begin
  if old.status = 'active' then
    perform snd_emit(old.workspace_id, 'billing.subscription.cancel', old.id,
      jsonb_build_object('subscription', old.id, 'customer', old.customer_id, 'plan', old.plan, 'monthly_cents', old.monthly_cents));
  end if;
  return null;
end $$;
create or replace function snd_shipment_gone() returns trigger language plpgsql as $$
begin
  if old.status in ('pending', 'in_transit') then
    perform snd_emit(old.workspace_id, 'carrier.shipment.void', old.id,
      jsonb_build_object('shipment', old.id, 'carrier', old.carrier, 'tracking', old.tracking));
  end if;
  return null;
end $$;
create or replace function snd_case_orphaned() returns trigger language plpgsql as $$
begin
  if old.customer_id is not null and new.customer_id is null and new.status = 'open' then
    perform snd_emit(new.workspace_id, 'helpdesk.case.orphaned', new.id, jsonb_build_object('case', new.id, 'subject', new.subject));
  end if;
  return null;
end $$;
-- Reads configuration: when finance turns on ledger mirroring, removing a payment books a reversal.
create or replace function snd_payment_gone() returns trigger language plpgsql as $$
begin
  if exists (select 1 from settings s where s.workspace_id = old.workspace_id and s.id = 'ledger_mirroring' and s.enabled) then
    insert into ledger_entries (workspace_id, id, kind, ref, amount_cents)
    select old.workspace_id, snd_id('le', old.id), 'payment_reversal', old.id, -old.amount_cents
    where exists (select 1 from workspaces w where w.id = old.workspace_id);
  end if;
  return null;
end $$;
create or replace function snd_order_cancelled() returns trigger language plpgsql as $$
declare paid int;
begin
  if old.status <> 'cancelled' and new.status = 'cancelled' then
    select coalesce(sum(p.amount_cents), 0) into paid from payments p join invoices i on i.workspace_id = p.workspace_id and i.id = p.invoice_id
      where i.workspace_id = new.workspace_id and i.order_id = new.id;
    update invoices set status = 'void' where workspace_id = new.workspace_id and order_id = new.id and status = 'open';
    -- Aggregate first: UPDATE ... FROM applies only one matching line per product, so two lines of one product would release one.
    update products p set reserved = p.reserved - l.qty
      from (select product_id, sum(qty)::int as qty from order_lines where workspace_id = new.workspace_id and order_id = new.id group by product_id) l
      where p.workspace_id = new.workspace_id and p.id = l.product_id;
    update shipments set status = 'voided' where workspace_id = new.workspace_id and order_id = new.id and status = 'pending';
    if paid > 0 then
      perform snd_emit(new.workspace_id, 'payments.refund.request', new.id, jsonb_build_object('order', new.id, 'amount_cents', paid));
    end if;
    perform snd_emit(new.workspace_id, 'mail.order.cancelled', new.id, jsonb_build_object('order', new.id, 'customer', new.customer_id));
  end if;
  return null;
end $$;

drop trigger if exists customer_erased on customers;
create trigger customer_erased after delete on customers for each row execute function snd_customer_erased();
drop trigger if exists subscription_gone on subscriptions;
create trigger subscription_gone after delete on subscriptions for each row execute function snd_subscription_gone();
drop trigger if exists shipment_gone on shipments;
create trigger shipment_gone after delete on shipments for each row execute function snd_shipment_gone();
drop trigger if exists case_touch on support_cases;
create trigger case_touch before update on support_cases for each row execute function snd_touch();
drop trigger if exists case_orphaned on support_cases;
create trigger case_orphaned after update on support_cases for each row execute function snd_case_orphaned();
drop trigger if exists payment_gone on payments;
create trigger payment_gone after delete on payments for each row execute function snd_payment_gone();
drop trigger if exists order_touch on orders;
create trigger order_touch before update on orders for each row execute function snd_touch();
drop trigger if exists order_cancelled on orders;
create trigger order_cancelled after update on orders for each row execute function snd_order_cancelled();

${[...TABLES, ...CONTROL].map(RLS).join(';\n')};
alter table workspaces enable row level security;
alter table workspaces force row level security;
drop policy if exists ws_isolation on workspaces;
create policy ws_isolation on workspaces using (id = current_setting('snd.ws', true) or current_setting('snd.ws', true) = '*')
  with check (id = current_setting('snd.ws', true) or current_setting('snd.ws', true) = '*');
${TABLES.map(CAPTURE).join(';\n')};
-- CREATE TABLE IF NOT EXISTS cannot upgrade a database made by an earlier schema. Every record is synthetic and
-- disposable, so instead of migrating, refuse to start on one (Codex R9-3).
do $$ begin
  -- Each constraint is looked up on its own table in this schema, not by name anywhere (Codex R10-1).
  if exists (select 1 from (values ('actions', 'actions_workspace_id_id_key'), ('approvals', 'approvals_workspace_id_id_key'), ('approvals', 'approvals_workspace_id_simulation_id_fkey'), ('executions', 'executions_approval_id_key'), ('executions', 'executions_workspace_id_action_id_fkey'), ('executions', 'executions_workspace_id_approval_id_fkey'), ('executions', 'executions_workspace_id_simulation_id_fkey'), ('simulations', 'simulations_workspace_id_action_id_fkey'), ('simulations', 'simulations_workspace_id_id_key')) need(tbl, con)
      where not exists (select 1 from pg_constraint where conrelid = to_regclass(need.tbl) and conname = need.con))
    or to_regclass('approvals_one_per_simulation') is null then
    raise exception 'This database was created by an earlier SOUNDING schema. Its data is synthetic: recreate the database, then start again.';
  end if;
end $$;
`;

/** Business triggers expected on the schema; the fingerprint covers these and every trigger function body. */
export const SCHEMA_TABLES: string[] = [...TABLES];
