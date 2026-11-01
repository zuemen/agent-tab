# PayPal sandbox evidence (2026-11-01)

Results of `npm run sandbox:smoke` against the real PayPal **sandbox** REST API (test money). Each run approves a $1.00 authorization with a sandbox personal account, then exercises the calls AgentTab depends on. Raw records are written to `.data/smoke-*.json` (not committed).

Runs: `smoke-2026-11-01T13-27-24-957Z-4be979` (final path) and `smoke-2026-11-01T14-04-25-745Z-7a0184` (void path + payout).

## Final path — authorize, capture in parts, refund, final capture

| Step | Result | PayPal id |
|---|---|---|
| Create order (`intent: AUTHORIZE`, $1.00) | OK | order `5DS95245Y0241551P` |
| Authorize after buyer approval | `CREATED`, expires 2026-11-30 | authorization `5B971902UW258473X` |
| Partial capture 1: $0.25, `final_capture=false` | `COMPLETED` | capture `0J341193UT376491H` |
| Resend capture 1 with the same `PayPal-Request-Id` | Same capture returned (no double charge) | `0J341193UT376491H` |
| Partial capture 2: $0.30, `final_capture=false` | `COMPLETED` | capture `204792631F3097319` |
| Read the order, match captures by `invoice_id` | Both captures found with their invoice ids | — |
| Refund $0.05 of capture 1 | `COMPLETED` | refund `9B584466T3338524P` |
| Resend the refund with the same request id | Same refund returned (no double refund) | `9B584466T3338524P` |
| Read the order, match refunds by `invoice_id` | 1 refund found | — |
| Final capture: $0.10, `final_capture=true` | `COMPLETED` | capture `4TR82962GY4976904` |
| Capture again after the final capture | Rejected: `422 AUTHORIZATION_ALREADY_CAPTURED` (expected) | debug id `f3120294a16d0` |

## Void path — capture in parts, release the rest, pay the seller

| Step | Result | PayPal id |
|---|---|---|
| Create order + authorize ($1.00) | `CREATED`, expires 2026-11-30 | authorization `6V615208ED936122H` |
| Partial capture 1: $0.25 + resend with same request id | `COMPLETED`, same capture returned | capture `78C1909747529322P` |
| Partial capture 2: $0.30 | `COMPLETED` | capture `08X72351PT3183723` |
| Read the order, match captures by `invoice_id` | Both found | — |
| Void the remaining authorization | OK | — |
| Capture after void | Rejected: `422 AUTHORIZATION_VOIDED` (expected) | debug id `f2290913aa46c` |
| Payouts: $0.05 to a sandbox personal account | Batch accepted, `PENDING` | batch `U8S3BRL2UEGHJ` |

## What this confirms

- Partial capture works on a default sandbox business app with no extra setting, so the tab can charge many small amounts against one approval.
- `PayPal-Request-Id` makes capture and refund resends idempotent, and `invoice_id` lets AgentTab recover a capture or refund whose response was lost.
- A tab cannot be charged after it is closed, whether it was closed with a final capture or a void.
- Payouts accepts the seller payout; the batch is asynchronous, so it starts as `PENDING`.

Not covered by these runs: capturing after PayPal's 3-day honor period (the authorization stays valid until its expiry, but PayPal may require a reauthorization for captures after day 3).
