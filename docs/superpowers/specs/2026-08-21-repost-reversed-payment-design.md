# Repost Reversed Payment Design

## Goal

Allow an operator to repost a fully reversed historical payment as a new interest-only payment while preserving the original intake, reversal history, and evidence unchanged.

## Scope

- Source intake must be tenant-accessible and have status `reversed`.
- Source intake must retain at least one finalized `ready` evidence row; evidence-free reversed duplicates are not eligible repost sources.
- Source repayment transactions must all have complete compensating reversals; any active source repayment stops preview and execution.
- Repost allocations must use component `interest` only and must exactly conserve the source intake amount.
- Target loans must be active, belong to the confirmed borrower, and have sufficient unpaid interest provenance for the source payment's Bangkok business date.
- One source intake may produce at most one successfully posted repost intake.
- Existing `needs_review` historical reconciliation remains supported and unchanged.

Out of scope:

- Reposting principal, fees, or penalties.
- Editing or deleting the source intake, evidence, transactions, reversals, or reconciliation records.
- Reusing this workflow for a partially reversed or currently posted intake.
- Copying evidence bytes or creating a second evidence record.

## Chosen Architecture

The reconciliation workflow accepts either a `needs_review` historical intake or a fully `reversed` intake. Preview records the source lifecycle mode and immutable source snapshot. For a reversed source, execute creates a new child payment intake with status `posted` and a tenant-safe `repost_of_intake_id` link to the source. Replacement transactions belong to the child intake; the reconciliation group continues to identify the source and records the child intake public ID in its immutable execution result.

The source intake remains `reversed`. Its evidence remains attached only to it. Reads expose the child-to-source lineage and allow the UI or MCP consumer to follow the source intake to its existing evidence without copying or re-finalizing it.

## Data Model

Add nullable `payment_intakes.repost_of_intake_id` with a tenant-scoped self foreign key and a partial unique index on `(tenant_id, repost_of_intake_id)` where non-null. This enforces at most one child repost per source intake.

Add nullable `payment_reconciliation_groups.posted_intake_id` with a tenant-scoped foreign key to `payment_intakes`. Existing `needs_review` execution sets both source and posted intake to the same intake. Reversed-source execution sets `payment_intake_id` to the reversed source and `posted_intake_id` to the new child.

The child intake copies only safe payment facts required for the posted ledger: tenant/owner, amount, received time, payer name, origin loan when applicable, source marker, and an audit note identifying the source public UUID. It does not copy bank-reference values, QR hashes, or evidence rows because those remain canonical on the source.

## Preview

`payment.reconcile.preview` keeps its current closed input schema. The backend derives mode from source status:

- `needs_review`: existing historical posting behavior.
- `reversed`: verify all original repayments are compensated and no active repayment remains; verify ready evidence exists and no prior repost child or executed reconciliation exists.

The preview output source snapshot includes `mode`, source status, source public UUID, source amount/time, fully reversed transaction public UUIDs, and whether ready evidence exists on the source. The proposed correction must always show principal, fee, and penalty as `0.00`.

Preview hashes the source transaction/reversal state, target loans, target accruals, existing floating allocations, repost-child absence, and proposed allocations. It persists no payment or transaction, only the expiring proposal and audit event.

## Execute

Execution requires the exact unexpired preview hash, balance version, matching reason, `confirmed: true`, and a stable idempotency key. It locks the proposal, source intake, target loans, target accruals, source transactions/reversals, and repost lineage in deterministic order, then recomputes the preview invariants.

For reversed mode, execution atomically:

1. Creates the child posted intake linked by `repost_of_intake_id`.
2. Creates exact interest-only replacement transactions under the child.
3. Creates floating-interest allocation provenance against the unpaid accruals for the historical effective date.
4. Updates only interest balances/accrual paid state; principal remains unchanged.
5. Creates immutable reconciliation entries, group, audit history, and marks the proposal executed.

An identical retry returns the original source and child public UUIDs. A conflicting key, second repost attempt, stale source, active source transaction, insufficient accrual provenance, or changed target balance stops without a partial write.

## Read Model and Presentation

Safe payment-intake reads include nullable `repostOfIntakePublicId` and `repostedByIntakePublicId`. The child displays as `posted (reposted after reversal)` and links to the original. The original remains `reversed` and may display the child link. Evidence retrieval follows the original intake only; the child does not claim a second evidence attachment.

The reconciliation execute result includes both `sourcePaymentPublicId` and `postedPaymentPublicId`, corrected transaction public UUIDs, audit public UUIDs, and correlation ID.

## Safety and Audit Invariants

- All money uses `decimal.js` and public two-decimal strings.
- Historical dates use the `Asia/Bangkok` business timezone.
- Original posted and reversed records remain immutable.
- Principal components are exactly `0.00` in every repost transaction and reconciliation entry.
- Every write carries actor/source, request/correlation ID, reason, and idempotency context.
- Database constraints prevent more than one repost child per source even under concurrency.
- No raw evidence, QR payload, bank reference, signed URL, or credential appears in logs or audit payloads.

## Verification

Database-backed tests must prove:

- One fully reversed source can repost interest across two floating loans.
- The original stays `reversed`; the child is `posted` and links to it.
- The child has no copied evidence row while the original ready evidence remains unchanged.
- Principal balances and principal components remain unchanged/`0.00`.
- Historical accruals receive exact paid amounts and immutable provenance.
- Partial reversal, active repayment, insufficient interest, stale preview, second repost, and conflicting idempotency all fail atomically.
- Identical execute retry returns the original result without additional rows.
- Existing `needs_review` reconciliation regressions remain green.

Run backend disposable PostgreSQL suites and typecheck, MCP contract tests, frontend tests/lint/build for changed read presentation, and plugin tests/validator if the public MCP contract changes.
