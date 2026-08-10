# Task 4 report — loan detail disbursement UI

## Delivered

- Added a responsive, localized `Daily repayment terms` card for fixed daily loans. It labels the scheduled amount as the agreed instalment and warns that early settlement uses its dedicated preview.
- Added clear loan-detail funding wording for direct own capital versus a bank drawdown; direct capital is no longer presented as an unmatched drawdown.
- Added a localized disbursement ledger panel that reads the approved/net/variance summary and supports draft creation or update, grouped-transfer validation, optional signed evidence upload/finalization, posting, and reason-required reversal.
- The UI never offers an edit control for posted or reversed rows. Selecting a posted row closes any draft editor; corrections are reversal plus a new draft.

## API contract used

`GET/POST /loans/:loanPublicId/disbursements`, `PUT /loans/:loanPublicId/disbursements/:disbursementPublicId`, and the child `post`, `reverse`, `evidence/upload-intents`, and `evidence/:evidencePublicId/finalize` routes from the approved ledger design. Money remains public two-decimal strings at the UI boundary.

## Verification

- `bun run test tests/loan-detail-disbursements.vitest.tsx` — passed (2 tests).
- `bun run build` — passed.
- Full `bun run test` is blocked by an existing `loan-wizard.vitest.tsx` assertion that still expects a repayment-type `<select>` although the current wizard uses radio controls.
- Full `bun run lint` is blocked by the pre-existing `LoanWizard.tsx:59` explicit-`any` lint error; this task's files add no lint findings.
