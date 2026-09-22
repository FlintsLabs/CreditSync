# Reviewed cancelled-payment duplicates: specification and implementation plan

Status: approved by the user on 2026-09-22. Existing payment authorization is retained; do not request the same payment confirmation again.

## Verified problem

Production main 1666eb7 implements cancelled replacement lineage but has no audited semantic-duplicate review command. `payment.replacement.inspect` reports eligible while `payment.replacement.create` rejects an unrelated cancelled semantic match. User has explicitly confirmed that the original and the cancelled duplicate represent one transfer. Passing that confirmation as a reason does not create structured review provenance. The attempted create rolled back with PAYMENT_DUPLICATE_REQUIRES_REVIEW. No payment was created or posted.

## Required behavior

- Record a human-confirmed duplicate relationship in a dedicated append-only, tenant-scoped review ledger. Do not edit cancelled/posted records, evidence, names, dates, amounts, hashes, or existing warnings.
- Review selects an exact canonical source and an explicit bounded set of cancelled duplicate drafts. Require cancellation audit provenance, exact decimal amount and received timestamp, matching normalized payer, and no transaction, restore, reconciliation, correction, successor, or conflicting hard evidence identity on the duplicate drafts. Fail closed on ambiguity.
- Only a tenant-authorized financial operator may confirm a current review preview. Include reason, actor/source, request/correlation IDs, idempotency key, immutable audit record, and hashes of the reviewed source/candidates and evidence/dependencies.
- The normal duplicate guard may exempt only records linked by an executed, still-valid review to the same canonical replacement chain. Posted, reversed, active, cross-tenant, unreviewed, or newly introduced duplicate matches continue to block.
- Both replacement inspection and creation must use the same duplicate assessment. Inspection must report the exact safe public blocker IDs and route to review instead of returning an unconditional allowed result.
- Review creates no payment or balance changes. Replacement still requires inspect/create, then ordinary ready preview with zero variance/no warnings and normal post. All financial calculations remain backend-owned decimal.js logic.

## Ordered implementation

1. Isolated worktree from current main, branch codex/reviewed-cancelled-payment-duplicates. Supervised tmux worker, gpt-5.6-luna medium, per AGENTS.md. Parent owns production actions.
2. Add synthetic disposable regressions for source+cancelled duplicate, rejected unreviewed replacement, review eligibility/dependencies, hard-identity conflicts, tenant/role boundaries, stale preview, idempotency/retry conflicts, concurrent review/create/post, no-fork/cycle and immutable audit/ledger guards.
3. Add next unused migration (inspect journal; expected 0080) for append-only review/link tables with tenant composite foreign keys, uniqueness and database mutation guards. Never change applied migrations.
4. Add review preview/execute service with deterministic locks and revalidation. Wire strict public MCP schemas and audit metadata, synchronize plugin version/catalog/contracts/profiles/evals. Implement shared duplicate assessment for inspect/create/preview/post and replacement descendants. Do not add a generic bypass or silently ignore every cancelled intake.
5. Exercise a synthetic confirmed THB 200.00 receipt with a cancelled duplicate: review, replacement, two scheduled THB 100.00 allocations, post once, retry without extra transactions; both original cancelled records and evidence unchanged.
6. Run full serial disposable backend suite, backend typecheck, frontend tests/lint/build, plugin tests/validator. Independently review diff, migration and immutable financial invariants. Update README and versioned CHANGELOG before commit.
7. Existing user authorization includes merge main, push, deploy and the confirmed payment. After implementation approval and successful gates, preserve existing production fixes, back up DB/object metadata consistently, rehearse migration and fingerprints, merge/push/deploy, verify schema/health/MCP.
8. Refresh actual source/duplicate/contract state. Submit audited review for the exact user-confirmed pair, create replacement with stable idempotency key, preview 100.00 to Sep20 and 100.00 to Sep21 of loan 01a0b303-0bae-7aaf-b37e-704a4dd74322, retaining receipt time 2026-09-21T12:05:00Z. Post only ready zero-warning fully allocated result, then reread receipt, schedules and history. Stop for genuinely new ambiguity, not repeated approval of the same known facts.

## Exclusions

No deletion or mutation of cancelled/posted history. No direct SQL financial posting, hash/name changes, arbitrary warning clearing, blanket duplicate exemptions, or changes to loan terms or allocation mathematics. No production test records. No additional borrower payments or the set-aside Sep17 slip.
