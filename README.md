# AgentTab

**A PayPal-authorized spending tab for AI agents.**

Your agent asks for a budget. You approve it once with PayPal. Every paid tool call the agent makes is checked against your rules, recorded on the tab, and captured from your PayPal authorization in batches. When you close the tab, the unused amount is released and each seller is paid out.

> Built for the PayPal AI Hackathon (2026). Repository started 2026-10-12. All payment flows run against the **PayPal sandbox** (test money).

---

## The problem

AI agents increasingly need to buy things per call: an article, a data query, an answer from a paid panel. Today the options are bad:

- **Give the agent your card.** No limits, no allowlist, no way to see what it bought until the statement arrives.
- **Approve every purchase by hand.** Safe, but it defeats the point of an agent. (The paid-MCP integration with PayPal support that we found asks for one approval per call.)
- **Pay per call on a card or PayPal.** Fixed fees make small charges uneconomic. US PayPal Checkout is 3.49% + $0.49 per transaction ([PayPal fees, 2026-10-01](https://www.paypal.com/us/business/paypal-business-fees)); the fixed fee alone on a $0.05 article is almost ten times its price.

## How AgentTab works

```
 Human (web)         AgentTab facilitator                     PayPal (sandbox)
 ───────────         ────────────────────                     ────────────────
 reviews request ──► create Orders v2 order, intent=AUTHORIZE ──► buyer approves
                     authorize order  ◄────────────────────────── authorization (the budget hold)

 AI agent (Claude) ──► seller's MCP tool ──► "payment required" (x402)
        │ signs a per-call charge with its own key
        └──────────► seller's MCP tool ──► /verify  (read-only checks)
                                         tool runs
                                         /settle  (atomic: check + record on the tab ledger)
                     when usage ≥ threshold ──► capture from authorization, final_capture=false
 Human closes/revokes ──► final capture (or void the rest) ──► Payouts to each seller
```

1. **The agent asks.** It proposes a budget, a per-call cap, the sellers it wants, and an expiry. The human can tighten any of them.
2. **The human authorizes once.** PayPal places a hold for the budget (Orders v2, `intent: AUTHORIZE`). No card number reaches the agent or the sellers.
3. **Every call is metered.** Seller tools answer with an x402 `PaymentRequired`. The agent signs a charge for exactly that price, seller and item. The facilitator checks it against the mandate and records it on the tab.
4. **Batched capture.** When the tab's uncaptured usage reaches the threshold, AgentTab captures that amount from the authorization (`final_capture: false`). Many calls → one capture → one fee.
5. **Close or revoke.** New charges stop, remaining usage is captured, the rest of the authorization is voided, and sellers receive their share through PayPal Payouts.

## What PayPal APIs are used

| PayPal capability | Where | What for |
|---|---|---|
| Orders v2 `POST /v2/checkout/orders` (`intent: AUTHORIZE`) | `packages/paypal/src/sandbox.ts` | The budget the human approves |
| Orders v2 `POST /v2/checkout/orders/{id}/authorize` | same | Turns the approval into an authorization (the hold) |
| Payments v2 `POST /v2/payments/authorizations/{id}/capture` with `final_capture: false` | same | Batched partial captures of actual usage |
| Payments v2 `POST /v2/payments/authorizations/{id}/void` | same | Releases unused budget on close/revoke |
| Payouts v1 `POST /v1/payments/payouts` | same | Pays each seller its share |
| `PayPal-Request-Id` on every money-moving call | same | Idempotent retries: a retried capture never captures twice |
| **PayPal Agent Toolkit** (`@paypal/agent-toolkit`, its MCP server run in-process): `get_order`, `list_transactions`, `create_refund` | `apps/demo/src/assistant.ts` | The tab assistant confirms charges with PayPal and issues refunds |

## Where the AI is

- **The buying agent** (`apps/agent/src/agent.ts`) is Claude with tool use. It sees each seller's tools and prices, decides what is worth buying for the owner's question, pays from the tab, and reports what it bought and why. Refused payments come back as tool errors and the agent explains them instead of working around them.
- **The tab assistant** (`apps/demo/src/assistant.ts`) answers the owner's questions about the tab ("what did the panel question cost?") and can refund a charge through the PayPal Agent Toolkit, behind a server-side guard: only this tab's own captures, never more than was captured.
- Without an `ANTHROPIC_API_KEY`, the demo agent runs a fixed **scripted** purchase plan instead, and the UI says so.

## What the tab enforces, and where

| Rule | Enforced by |
|---|---|
| Total spend ≤ budget | Facilitator ledger, and ultimately the **PayPal authorization amount**: captures never exceed it |
| Per-call cap | Facilitator (`checkCharge`) |
| Seller allowlist | Facilitator |
| Expiry ≤ 71 hours | Mandate validation. PayPal honors authorized funds for 3 days ([auth honor period](https://developer.paypal.com/docs/checkout/standard/customize/authorization/)), so a tab never relies on funds PayPal no longer guarantees |
| Charge = seller's actual price and item | The agent signs `{tab, seller, item, amount, nonce, expiry}` with its Ed25519 key; the facilitator rejects anything that differs from the seller's requirements |
| No replay, no forgery | Nonces are burned on use; only the key on the mandate can sign. The signature protects against sellers and third parties. It does not replace the hard cap, which is the PayPal authorization |
| Revoke | One call: stop new charges, capture what was used, void the rest |
| Capture failure | A definitive PayPal error freezes the tab (no new charges). Ambiguous errors (network, 5xx) are retried with the same `PayPal-Request-Id` |

## Run it

Requires Node 20+.

```bash
npm install
cp .env.example .env      # add PayPal sandbox credentials (optional) and ANTHROPIC_API_KEY (optional)
npm start                 # http://localhost:4020
```

- **With** `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` (a sandbox REST app from developer.paypal.com): real PayPal sandbox calls. Approve with a sandbox *personal* account.
- **Without** them: a clearly labeled **simulated rail** (in-memory stand-in, no PayPal calls) so the flow can be explored offline.
- `PAYOUT_RECEIVER`: sandbox personal email that receives seller payouts.

Then: **Start the demo → review the agent's request → Authorize with PayPal → Run the agent → Close tab.**

### Test the money path against the sandbox

```bash
npm run sandbox:smoke     # authorize → partial capture ×2 (+ idempotent retry) → final capture | void → payout
```

It prints an approval link, waits for you to approve with a sandbox buyer account, and writes a JSON record of every PayPal id and status to `.data/`.

### Use the sellers from your own MCP client

Each demo seller is a Streamable HTTP MCP server at `http://localhost:4020/mcp/<seller-id>` (`harbor-gazette`, `openfield-data`, `field-panel`, `velvet-insights`). Paid tools answer with an x402 `PaymentRequired` until paid with a `paypal-tab` charge.

## Tests

```bash
npm test          # 46 tests: ledger, PayPal rail, x402 scheme over MCP end to end, demo server, assistant refund guard
npm run typecheck
```

The end-to-end tests run the official x402 MCP client and resource server (`@x402/mcp`, `@x402/core` 2.28.0) against the facilitator with the simulated rail: paid calls, batched captures, close, void, payouts, off-list seller refused, budget exhausted, revoke, and capture failure freezing the tab.

## Technical notes

- **x402-compatible, PayPal-settled.** `paypal-tab` is a custom x402 v2 scheme (`packages/x402-paypal`): `asset: "USD"` (the v2 spec allows ISO 4217 for fiat), `amount` in micro-USD so sub-cent prices stay exact, `network: "paypal:sandbox"`. It is **not an official x402 scheme**, and PayPal is not involved in x402; we use the protocol's message format so standard x402 MCP clients and servers can carry PayPal-settled payments.
- **Read-only verify, atomic settle.** As the x402 spec requires, `/verify` never writes. `/settle` checks and records in one step, after the tool succeeded, so a failed tool is never charged.
- **Write-ahead captures.** The capture record and its `PayPal-Request-Id` are persisted before PayPal is called, so a crash mid-capture is retried idempotently instead of captured twice.
- **Fees.** With a $10 batch threshold, total fees are about 8.4% of each capture (3.49% + $0.49 on $10), instead of the fixed $0.49 alone being 980% of a single $0.05 call. The demo uses a $0.50 threshold so captures are visible within a short run.

## Prior art (searched 2026-10-12)

| Project | What it does | Difference |
|---|---|---|
| PayMCP | Paid MCP tools; its PayPal mode creates one order per call with a human approval link | AgentTab: one approval per budget, then unattended metered calls |
| Stripe machine payments (MPP + x402) | Agents pay per call; settles to Stripe | AgentTab settles through PayPal authorization and capture |
| Nevermined `card-delegation` (draft) | x402 fiat scheme with delegated card limits, incl. Braintree `sale` per payment | AgentTab: one authorization + batched partial captures, MCP transport, seller payouts |
| CrawlerPal (PayPal Dev Days 2025) | Agent pays content paywalls with a vaulted PayPal account | AgentTab: per-call metering under a human-set mandate across many sellers |

We did not find a public implementation that combines a single PayPal authorization as the budget, batched partial captures, a mandate enforced per call, x402/MCP compatibility, and payouts to multiple sellers. That is a statement about our search, not a claim of being first.

## Known limitations

- **Sandbox only.** Production needs PayPal's multiparty (platform) setup instead of Payouts, plus seller onboarding.
- **Partial captures** on PayPal-wallet authorizations may need to be enabled on the merchant account. If they are not, set the capture threshold equal to the budget: the tab then captures once, at close.
- **Seller trust.** A seller can settle a charge and return a poor answer. The owner can refund through the tab assistant; disputes beyond that follow PayPal's normal process.
- **Single process, JSON persistence.** Fine for a demo; a real deployment needs a database.
- **Tabs longer than 3 days** would need PayPal reauthorization, which is not implemented.

## Layout

```
packages/core         mandate, signed charges, ledger, batched capture, payouts (pure TypeScript)
packages/paypal       PayPal REST rail (sandbox) + simulated rail
packages/x402-paypal  the paypal-tab x402 scheme (server + client)
apps/facilitator      x402 facilitator + tab API (Hono)
apps/seller-mcp       demo sellers as MCP servers (fictional data)
apps/agent            Claude buying agent + scripted mode
apps/demo             all-in-one server, web UI, tab assistant (PayPal Agent Toolkit)
scripts               sandbox smoke test
```

Demo sellers, places and figures are fictional.

## License

Apache-2.0. PayPal is a trademark of PayPal, Inc. This project is not affiliated with or endorsed by PayPal.
