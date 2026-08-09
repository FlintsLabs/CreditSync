# Payment matching policy

CreditSync owns matching decisions. Agent-side text matching may gather candidates but never authorizes a financial post.

## Name handling

- Preserve the original name or nickname for display.
- CreditSync normalizes Unicode with NFKC, trims/collapses whitespace, lowercases English, and removes non-meaningful punctuation.
- A unique canonical name or confirmed alias can identify a candidate. A duplicated confirmed alias remains ambiguous.
- Fuzzy matching only ranks candidates. It always requires review.
- An intermediary name identifies the transfer source, not automatically the borrowers receiving allocations.

## Proposal states

| State | Meaning | Agent action |
| --- | --- | --- |
| `ready` | Explicit allocations total the intake or one uniquely confirmed identity has one clear matching obligation. | Show exact allocation and post only the latest proposal. |
| `needs_review` | Identity, obligation, amount, or fuzzy match is ambiguous. | Show candidates, obligations, warnings, and difference; wait for a human choice. |
| `duplicate` | Tenant-scoped idempotency key, bank reference, QR hash, or evidence SHA-256 matches an existing intake. | Inspect and return the original intake; do not create/post another. |
| stale/expired | Proposal is no longer current. | Re-inspect balances and request another preview. |

Semantic similarity (nearby amount/time/name) is a warning, not a hard duplicate. Explicit grouped allocations may span multiple loans and borrowers, but CreditSync must validate that their exact total and current outstanding obligations remain valid inside the posting transaction.
