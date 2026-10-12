# AgentTab architecture

AgentTab lets a person give an AI agent a **PayPal-authorized spending tab**. The agent pays sellers per tool call under rules the person set; money moves through PayPal in batches.

## Components

```
                         ┌──────────────────────────── demo server (apps/demo, one Node process) ───────────────────────────┐
 Browser (owner)         │                                                                                                  │
 web UI  ───────────────►│  Tab API + x402 facilitator (apps/facilitator)        Seller MCP servers (apps/seller-mcp)       │
  review terms           │   • tab requests, terms, close/revoke, refunds         • Harbor Gazette, Openfield Data,         │
  authorize w/ PayPal    │   • /verify (read-only) /settle (atomic) /supported      Field Panel, Velvet Insights (fictional) │
  live ledger (SSE)      │   • batched capture, reconciliation, payouts           • paid tools answer x402 PaymentRequired  │
  confirm refunds        │   • TabService ── PayPalRail ─────────────────┐        • POST /mcp/<seller> for any MCP client   │
  ask the assistant      │                                               │                                                  │
                         │  Buying agent (apps/agent)                    │        Tab assistant (apps/demo/assistant.ts)    │
                         │   • Claude tool loop, or scripted plan        │         • Claude + PayPal Agent Toolkit MCP      │
                         │   • x402 MCP client + paypal-tab scheme       │           (get_order on this tab's order)        │
                         │   • signs each charge with its Ed25519 key    │         • proposes refunds; owner confirms       │
                         └───────────────────────────────────────────────┼──────────────────────────────────────────────────┘
                                                                         ▼
                                                    PayPal REST (sandbox): Orders v2, Payments v2, Payouts v1
```

| Package | Responsibility |
|---|---|
| `packages/core` | Pure logic: mandate validation, Ed25519-signed charges, ledger (check / reserve / settle), batched capture planning, payouts split, refund planning. No I/O. |
| `packages/paypal` | `PayPalRail` interface. `SandboxRail` calls PayPal REST with `PayPal-Request-Id` on every money-moving call. `SimulatedRail` is an in-memory stand-in for tests and keyless runs (labeled in the UI). |
| `packages/x402-paypal` | The `paypal-tab` x402 v2 scheme: server side (`parsePrice`, requirements) and client side (signs a charge for exactly the requested seller, item and amount). |
| `apps/facilitator` | `TabService` (state machine, persistence, PayPal orchestration) and the HTTP API (Hono). |
| `apps/seller-mcp` | Demo sellers as MCP servers using the official `@x402/mcp` payment wrapper. |
| `apps/agent` | The buying agent: Claude with tool use (prompt caching, adaptive thinking), or a scripted plan without an API key. |
| `apps/demo` | All-in-one server: facilitator + sellers over MCP + agent runner + tab assistant + web UI. |

## Money flow

1. **Request.** The agent (with its public key) asks for a tab: budget, per-call cap, sellers, capture threshold, expiry. The response's review link carries an **owner key** in the URL fragment for the human.
2. **Authorize.** The owner reviews and tightens the terms, then AgentTab creates a PayPal order with `intent: AUTHORIZE` for the budget. The order description repeats the terms, so they are visible on PayPal's own approval page. After approval AgentTab calls `authorize`; the tab opens only if the authorization status is `CREATED`.
3. **Pay per call.** A paid MCP tool answers with an x402 `PaymentRequired` (`scheme: paypal-tab`, `asset: USD`, `amount` in micro-USD). The agent signs `{tabId, seller, resource, amountMicros, nonce, issuedAt, expiresAt}`. The seller's server calls `/verify` (read-only checks), runs the tool, then `/settle`, which checks again and records the call on the ledger in one step. A failed tool is never charged.
4. **Batched capture.** When uncaptured usage reaches the threshold, AgentTab captures that many cents from the authorization with `final_capture: false`. The capture record and its `PayPal-Request-Id` are written to disk before PayPal is called.
5. **Close or revoke.** New charges stop; remaining usage is captured (final capture), otherwise the authorization is voided; once every capture is `COMPLETED`, sellers are paid with one Payouts batch. Each step that fails for a temporary reason leaves the tab `closing` and a periodic sweep resumes it.
6. **Refund.** The owner (or the assistant, as a proposal) picks a paid call. The refund is executed only when the owner confirms, against the capture that took that call in, and comes out of that seller's payout.

## Invariants

| Invariant | How it holds |
|---|---|
| Captured total ≤ authorized budget | `planCapture` caps every capture at `budget − captured`; final capture rounds half-up but stays within the budget (fuzz-tested in review). |
| Nothing is captured twice | One capture in flight per tab; fixed `PayPal-Request-Id` per capture record; write-ahead persistence; before judging any failure, `reconcile()` reads the PayPal order and adopts captures matched by `invoice_id`. |
| Only money PayPal reports as received is paid out | Payouts count captures with PayPal status `COMPLETED`, minus completed refunds; they wait while a capture is `PENDING`. |
| A refused or failed call costs nothing | `/settle` runs after the tool succeeds; refused charges never reach the ledger. |
| Only the owner manages the tab | Owner key (sha256 at rest) required for terms, close, revoke, refunds, assistant, agent runs, and the event stream (one-time ticket). Everyone else sees a minimal status. |
| Funds are guaranteed while the tab is open | Tab lifetime ≤ 60 hours: inside PayPal's 3-day honor period with a 12-hour retry margin. |

## Failure handling

| PayPal answer | Treatment |
|---|---|
| Capture `COMPLETED` | Counted as received. |
| Capture `PENDING` | Counted as captured (no second capture); payouts wait until reconciliation shows `COMPLETED`. |
| Capture `DECLINED` / `FAILED`, or HTTP 422 (after reconciliation finds no capture) | Definitive: the record fails and the tab freezes (no new charges). Close still attempts the final capture. |
| Network error, 5xx, 429, 401/403, 409 | Not definitive: the record stays pending and is retried with the same `PayPal-Request-Id` after reconciliation. |
| Void fails temporarily | Tab stays `closing`; sweep retries. Codes meaning "nothing left to void" count as done. |
| Payout fails temporarily | Same batch id retried by sweep; definitive failures are recorded for manual follow-up. |

## x402 compatibility

- Message format: x402 v2 `PaymentRequired` / `PaymentPayload` / `SettleResponse` over the official MCP transport (`_meta["x402/payment"]`, `_meta["x402/payment-response"]`).
- Libraries: `@x402/core` and `@x402/mcp` 2.28.0; the scheme is registered like any other x402 scheme.
- `paypal-tab` and the `paypal:*` network names are **ours**, not part of the x402 specification, and PayPal is not involved in x402.
- `SettleResponse.transaction` is the ledger reference (`tabId:seq`); the PayPal capture ids appear on the tab when the batch is captured.

## Trust boundaries and known limits

- **Agent.** Can only spend within the mandate; its key signs charges, so sellers cannot forge or replay them. An agent that receives the review link also receives the owner key; the terms on PayPal's approval page and the live dashboard are the checks against an agent that tampers with its own request. A production deployment would authenticate the owner directly (for example with Log in with PayPal).
- **Seller.** Is paid only for calls it settles after running the tool, at the price the agent signed. It can still return a poor answer; the owner's remedy is a refund.
- **Tab assistant.** Can read this tab and look up this tab's PayPal order. It cannot move money; refunds it proposes need the owner's confirmation.
- **Not built:** reauthorization for tabs longer than 3 days, PayPal multiparty platform fees (Payouts is used instead), a database (JSON file persistence), seller onboarding.
