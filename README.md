# RoyaltySplit

A payor escrows self-declared streaming revenue in GEN. GenLayer’s AI only judges whether that figure is plausible against public sources. The signed percentage is split with integer math in the contract, outside AI consensus.

> RoyaltySplit needs GenLayer: no EVM smart contract can read unstructured public streaming data well enough to judge whether a self-reported revenue figure is plausible, and no auditor is cheap enough to check a large number of small independent-artist splits. Only GenLayer’s decentralized AI consensus can do that at near-zero cost, while the money math stays as exact as an ordinary smart contract.

## The problem

An artist and a label or distributor agree a fixed split, for example 60/40. The period’s actual revenue is usually reported by the one party who holds the platform account. The artist has no cheap way to check whether that number was understated.

## Why the AI does not calculate the percentage

JobVerdict was rejected because the AI computed a percentage score and that tolerant score was then turned into a payment. Two validators could “agree” and still settle two different amounts. RoyaltySplit never lets the AI calculate or decide any amount of money. The AI only answers yes or no on whether the declared data is plausible. The real percentage split runs in ordinary Python, not inside `leader_fn` or `validator_fn`. Every validator executes that same deterministic code, so the result is exact. It is not an LLM output.

Flow:

1. When the agreement is created, the parties fix `artist_split_bps` (1–9999). That number does not change, and it is not an AI output.
2. The payor declares `declared_revenue_amount` by attaching that exact GEN amount (`gl.message.value`).
3. `gl.vm.run_nondet` returns only `DATA_PLAUSIBLE` or `DATA_DISPUTED`, plus a confidence score, plus the sha256 and excerpt of every page that was read. Validators must match the verdict label, whether confidence clears 60, and those page hashes. They do not compare money. A URL by itself is not evidence.
4. Confidence below 60 sets `LOW_CONFIDENCE_DISPUTED`. GEN stays in escrow. The unreadable or low-confidence pages stay on the agreement. Add sources, then resolve again.
5. `DATA_DISPUTED` with confidence at least 60 pays the full escrow to the artist. The payor, who attested the figure, does not receive it back.
6. `DATA_PLAUSIBLE` with confidence at least 60 calls `_execute_split_settlement`, outside `run_nondet`:

```text
artist_amount = (declared_revenue_amount * artist_split_bps) // 10000
payor_share   = declared_revenue_amount - artist_amount
```

The remainder of the integer division stays with the payor. The two sides always sum to the escrowed amount.

## MVP limit

Each `RoyaltyAgreement` is **one payment period**, not a contract that repeats automatically. For another period, create a new agreement and enter the agreed percentage again. A repeating multi-period contract can come in a later milestone.

## Contract

One contract holds the GEN. The payor escrows into the contract. The contract calls `emit_transfer` for the artist and returns the remainder to the payor. Value is not forwarded through a cross-contract call.

| Action | API |
|---|---|
| Caller | `gl.message.sender_address` |
| Send GEN | `gl.get_contract_at(recipient).emit_transfer(value=u256(amount))` |
| Receive attached GEN | `@gl.public.write` + `gl.message.value` |
| Map with default | `self.agreements.get(key, None)` |

Required header:

```python
# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

Deploy notes: [scripts/deploy/studionet.md](scripts/deploy/studionet.md).

## Live App

https://royaltysplit-genlayer.vercel.app

## Deployed Contract

`0xefc83BECd5fC9C5D0A887221abd3699d4c0CAAf2`

https://explorer-studio.genlayer.com/address/0xefc83BECd5fC9C5D0A887221abd3699d4c0CAAf2

### Status

`AWAITING_DEPOSIT` → `DEPOSITED` → one of:

- `RESOLVED` — both sides were paid
- `DATA_DISPUTED_AWARDED` — the artist was paid the full escrow
- `LOW_CONFIDENCE_DISPUTED` — funds stay put; more sources may be added
- `PAYOUT_FAILED` / `DISPUTE_PAY_FAILED` — `retry_resolution` sends only the side whose flag is still false

`artist_paid`, `payor_share_returned`, and `dispute_settled` guard each leg. A retry does not pay twice. `get_agreement` returns each source URL with the sha256 and the excerpt the validators actually read.

## Money handling

Every GEN amount goes through `bigint` / `BigInt`. There is no `float`, `parseFloat`, `Math.round`, `Math.floor`, or `Math.ceil` on a money value.

| Place | Function | Method | Note |
|---|---|---|---|
| Contract | `_split_amounts` | `(total * bps) // 10000`, remainder to the payor | Pure function. It is not called from `leader_fn` or `validator_fn`. |
| Contract | `deposit_revenue` | Same `_split_amounts` | Rejects a deposit that would pay either side 0, so `emit_transfer` is never called with 0. |
| Contract | `_execute_split_settlement` | Same `_split_amounts`, then `emit_transfer` | Runs only after the verdict is `DATA_PLAUSIBLE`. |
| Contract | `_award_disputed` | Pays `declared_revenue_amount` to the artist | Does not apply the percentage. The payor receives 0. |
| Contract | `get_agreement` | Writes `artist_amount` and `payor_share` with `_split_amounts` | On-chain preview. Not an AI output. |
| Frontend | `parseGenToWei` | Split the string, pad 18 fractional digits, `BigInt` | Rejects scientific notation. |
| Frontend | `formatWeiToGen` | `wei / 10^18` and `wei % 10^18` with `BigInt` | Display only. |
| Frontend | `computeSplitPreview` | `(total * bps) / 10000n` | Same formula as the contract, for the preview before signing. |
| Frontend | `percentToBps` | Integer percent 1–99 times 100 | UI basis points, not wei. |
| Frontend | `toWeiString` | Digit string or `bigint` | A JavaScript `number` is rejected and becomes `0`. |
| AI | `leader_fn` | JSON `{verdict, confidence, reason}` | If the model invents a money field, `_parse_verdict` drops it. |

Hand checks locked in tests:

| declared (base units) | bps | artist | payor | total |
|---|---:|---:|---:|---:|
| 1000 | 6000 | 600 | 400 | 1000 |
| 10001 | 6000 | 6000 | 4001 | 10001 |
| 10 GEN (`10 * 10^18` wei) | 6000 | 6 GEN | 4 GEN | 10 GEN |

`1000 * 6000 // 10000 = 600`. `10001 * 6000 = 60006000`; `60006000 // 10000 = 6000`; payor = `10001 - 6000 = 4001`.

## Tests

```bash
gltest tests/test_royalty_split.py
node scripts/check-no-float-money.js
npm run test:money
```

Contract suite (`gltest`): the `DATA_PLAUSIBLE` path pays the artist 600 and the payor 400; the `DATA_DISPUTED` path pays 1000 to the artist and 0 to the payor; the stored evidence excerpt hashes to the page that was read; a different page hash is not accepted; low confidence keeps the escrow, then more sources are added and resolve runs again; basis points outside 1–9999 are rejected; a missing URL is rejected; the same wallet is rejected; a second deposit and a second resolve are rejected; a 1 wei deposit at 6000 bps is rejected because the artist would receive 0; artist-only, payor-only, both-sides, and disputed-award transfer failures are covered. `retry_resolution` sends only the missing leg and does not pay twice.

## Frontend

Vite + React. The only chain is **GenLayer Studionet**.

Without `VITE_CONTRACT_ADDRESS` the app shows a banner and does not crash. The form is still visible. Writes stay disabled until an address is set.

Fixed banner: “Free to use. You only pay GenLayer network gas when you sign a transaction. There is no other platform fee.”

```bash
cd frontend
npm install
npm run dev
```

Environment: `frontend/.env` → `VITE_CONTRACT_ADDRESS=0xefc83BECd5fC9C5D0A887221abd3699d4c0CAAf2`
