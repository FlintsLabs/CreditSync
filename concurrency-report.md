# Payment workflow concurrency report

Lock inventory and regression coverage for the payment workflow recovery task.

## Lock-order inventory

| Entry point | Locks acquired (outer → inner) | External I/O under lock |
| --- | --- | --- |
| `createPaymentIntake` | tenant workflow mutex → identity minute/window mutexes → duplicate read → intake insert | none |
| `previewPaymentMatch` | tenant workflow mutex/identity mutex → intake row → borrower/loan/schedule reads | none |
| `postPayment` | tenant workflow mutex/identity mutex → borrower locks → intake/proposal/loan/schedule rows | none |
| `cancelPaymentIntake` | tenant workflow mutex → borrower locks → batch rows → intake rows | none |
| `preparePaymentEvidence` | intake row for durable intent; storage signing occurs after the DB transaction | signing is outside DB transaction |
| `finalizePaymentEvidence` | storage HEAD first; tenant workflow mutex/identity mutex → intake row → evidence row | HEAD is before locks |
| `createPaymentReplacement` | tenant workflow mutex/identity mutex → replacement idempotency/source mutexes → source/intake/lineage/evidence rows | none |
| duplicate review preview | tenant workflow mutex/identity mutex → participant/replacement/dependency reads and review rows | none |
| duplicate review execute | tenant workflow mutex → review/idempotency mutexes → participant replacement mutexes → membership rows | none |
| batch execute | tenant workflow mutex → deterministic borrower locks → batch/intake/loan/schedule rows | none |

The tenant mutex must be acquired before any payment row lock on every participating writer. Identity keys must cover the same five-minute candidate window used by duplicate detection; the boundary crosses minute hashes and therefore requires all nine minute keys.

## Required regression scenarios

The implementation test file maps one test to each item below, with 20 iterations per ordering and bounded completion:

1. cancel vs post on a ready scheduled payment, both orderings.
2. evidence finalize vs cancel on a pending upload, both orderings, using a fake storage adapter and real DB transition.
3. preview vs batch post for a shared affected loan/intake.
4. overlapping identity group executions.
5. same-identity create vs post at an adjacent-minute boundary.
6. replacement creation vs group extension.

The final section also verifies replay after a committed operation loses its response and checks one durable receipt/effect.

## Verification constraints

- Database-backed tests run serially through `backend/scripts/test-disposable-postgres.sh`.
- No live tenant, deploy, push, or merge actions are part of this report.

## Verification

`concurrency-targeted-final.log` exited `0`: all six scenarios passed at 20 iterations, with both required orderings. `concurrency-replay.log` exited `0`: committed cancellation and post replay returned the original durable result with one financial transaction. Backend typecheck also exited `0`.

The production delta is narrow: `previewPaymentMatch` and `finalizePaymentEvidence` now use the existing `withPaymentWorkflowTransaction` policy, retrying only SQLSTATE `40P01`/`40001` around the complete replay-safe transaction, maximum three attempts. No external I/O was moved under the DB lock.
- Full backend suite remains the parent worker's next gate.
