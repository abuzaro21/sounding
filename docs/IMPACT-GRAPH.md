# Impact graph

Two things are called the impact graph here: the **attribution** that maps every measured effect back to the target that caused it, which the policy and the reviser use, and the **consequence canvas** that draws it.

## Attribution

Code: `attribution` in [src/policy.ts](../src/policy.ts).

The policy must say not only "an unpaid invoice would be deleted" but also *which customer* in the target list causes it, so that the agent can exclude exactly that customer. Attribution uses only before and after images from the effect set. It never runs a query, so it describes what the dry run did, not what the schema suggests.

Effects are processed parent-first:

```
orders, subscriptions, invoices, payments, shipments, order_lines, addresses, support_cases, customers, ledger_entries, outbox, products
```

| Effect | Root |
|---|---|
| a directly deleted customer | itself |
| orders, subscriptions, addresses, support cases | `customer_id` from the before image (for a `SET NULL` case, the before image still holds it) |
| invoices, shipments, order lines | the root of their order (purge), or the order itself (cancel) |
| payments | the root of their invoice |
| ledger entries | the root of the payment in `ref` |
| outbox messages | the first payload reference that resolves: customer, subscription, shipment, case, then order |
| collateral customer edits (referral `SET NULL`) | the deleted referrer named in `referred_by` |

Every finding carries `roots` (sorted, unique) and `rows` (`tbl`, `id`, note). The Proposal panel shows which targets each rule blocks (`blocked_by`), and the reviser excludes exactly those.

## The consequence canvas

Code: `nodesOf` and `Canvas` in [ui/src/Canvas.tsx](../ui/src/Canvas.tsx).

The canvas is split by a **waterline**. Above it is what the agent asked for: the direct effects on the target table. Below it is everything the change drags along, layered by depth in the FK graph:

```
  customers: 48 deleted                                  ← asked for                 depth 0
 ────────────────────────────── waterline ──────────────────────────────
  orders · subscriptions · addresses · support cases · customers (edited)          depth 1
  invoices · shipments · order lines                                               depth 2
  payments                                                                          depth 3
  ledger entries                                                                    depth 4
  ─ Leaving the building ─
  outbox: messages to CRM, billing, carrier, helpdesk                               depth 99
```

- Each node is a table and operation, with its count and causes (cascade, set null, trigger, restored).
- Nodes containing rows named by a **blocking** finding are marked "blocked". Warnings are not marked.
- A sounding line with a lead weight drops to the deepest layer the change reaches.
- Every node is a button (`aria-label` "payments: 31 deleted, blocked"). Activating it filters the before/after diff to that layer.
- For a restoration, the labels read "restored" and "restored along with them".

## Before → after

Code: [ui/src/Diff.tsx](../ui/src/Diff.tsx).

- Rows are sorted by layer, then in the order the dry run made them.
- Deletions show the key columns that disappear. Updates show only the columns that change. Inserts show what appears.
- Rows a rule names carry the rule and its note, and "Only rows a rule names" filters to them.
- **now** re-reads the live row (masked) with its current row version (`xmin`), so drift after the simulation is visible before executing.
