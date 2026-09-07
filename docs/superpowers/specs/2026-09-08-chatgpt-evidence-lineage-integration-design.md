# ChatGPT Evidence Production-Lineage Integration Design

## Status

Approved direction. This design integrates the existing ChatGPT payment-evidence feature into `main` while preserving the migration already applied in production and the subsequently deployed scheduled-payment allocation-correction migration.

## Context

Production contains 66 Drizzle migration rows while `main` contains 62. Every migration in `main` is present in production with the same hash and timestamp. Three additional production rows are the recognized legacy mixed-lineage tail. The fourth additional row is the exact hash of `0061_chatgpt_payment_evidence` from `codex/chatgpt-evidence-upload`, applied at timestamp `1788739200000`.

Production therefore already has `payment_intakes.evidence_required`, the additional `payment_evidence` provenance columns, and `payment_evidence_supplements`. The corresponding service, MCP, plugin, UI, tests, and migration source are not present in `main`. Production also contains the later allocation-correction migration at timestamp `1788811800000`.

## Goal

Make `main` the complete source of truth for the schema and application behavior already represented in production, without editing or deleting production migration rows and without mutating financial records.

## Non-goals

- Do not rewrite, delete, reorder, or fabricate production journal rows.
- Do not rerun the already-applied ChatGPT evidence DDL against production.
- Do not alter payment amounts, allocations, schedules, balances, evidence rows, or other financial history.
- Do not merge unrelated work from the feature branch.
- Do not upload evidence or create a live financial test record during verification.

## Integration Strategy

Create an isolated integration branch from current `main`. Port the seven ChatGPT evidence commits in their original order, resolving conflicts against the allocation-correction implementation rather than merging the old branch tip wholesale.

The existing `0061_chatgpt_payment_evidence.sql` bytes and timestamp must remain identical to the row already recorded in production. In the reconciled local journal it becomes a historical deployed entry before `0061_scheduled_payment_allocation_corrections`; journal indexes and filenames must be made unique and monotonic without changing either deployed SQL hash. The preferred result is to rename migration files/tags only where Drizzle metadata permits the SQL bytes to remain unchanged, and to retain the production timestamps:

1. ChatGPT evidence at `1788739200000`, hash `ba93514f…2230`.
2. Scheduled allocation correction at `1788811800000`, hash `10eb2edf…9a39f`.

If Drizzle requires a new local index/tag, the journal may assign the ChatGPT evidence entry before allocation correction while preserving the exact SQL file bytes. No compensating production DDL is needed because both hashes are already present.

## Conflict Policy

Conflicts in shared files—database schema, payment services, MCP catalog, frozen contract, plugin version/evals, changelog, README, and reconciliation guard—must combine both features. Allocation-correction safety invariants remain authoritative, including append-only compensation, stale-state checks, dependency blockers, idempotency request hashing, and closed MCP outputs. ChatGPT evidence invariants remain authoritative as defined in the existing payment-slip ingestion design.

Generated/frozen artifacts must be regenerated from the combined source rather than choosing either branch's version. Plugin and frontend release versions must advance once to describe the combined contract.

The pre-merge stash `stash@{0}` is preserved as recovery evidence. Its duplicate/older allocation-correction edits are not applied automatically; any unique semantic assertion must be compared against the combined implementation before the stash is retained or removed.

## Reconciliation Guard

Update `reconcile-production-mixed-lineage.ts` so it recognizes the exact production superset: the three established legacy rows, the deployed ChatGPT evidence hash, and the allocation-correction hash. Verification must fail closed for unknown hashes, altered timestamps, missing rows, duplicate hashes, or catalog mismatch.

The guard must distinguish these supported states:

- a fresh database following the reconciled `main` journal;
- the current production lineage containing the recognized legacy tail;
- an older supported production state before either new feature;
- invalid partial or reordered states, which remain non-actionable without human review.

## Verification

- Assert the reconciled journal is monotonic and contains each deployed hash exactly once.
- Compare the combined migration hashes and timestamps against production read-only output.
- Run disposable PostgreSQL tests for both ChatGPT evidence and allocation correction, then the complete serialized backend suite.
- Run backend typecheck; frontend tests, lint, and build; plugin tests and both validators.
- Independently review the combined diff for financial integrity, idempotency, tenant isolation, raw-file/URL leakage, migration replay, and frozen-contract synchronization.
- Before deployment, verify the production journal and target catalog read-only. After deployment, verify no new migration row was inserted for an already-applied hash, backend logs show successful no-op migration handling, MCP health returns 200, and the frontend returns 200.

## Rollout and Recovery

Merge only after all gates pass. Deploy backend and frontend using the existing production Compose workflow. The expected production migration effect is a no-op because both deployed hashes already exist; any attempted duplicate DDL or unexpected new journal row stops rollout for review.

Rollback is application-only: redeploy the prior images if runtime behavior fails. Database rollback is prohibited because the evidence and allocation schemas are additive and already deployed. Preserve logs using public IDs and migration hashes only; never expose evidence contents, temporary URLs, tokens, or raw financial identifiers.

