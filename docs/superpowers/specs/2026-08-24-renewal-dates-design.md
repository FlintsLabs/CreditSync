# Renewal Effective and Payment Start Dates Design

**Status:** Approved in conversation; pending written-spec review

## Goal

Allow a daily-loan renewal to specify the date the old contract is settled and the replacement starts, separately from the date the first replacement payment is due. This supports a renewal on 2026-08-22 with the first collection on 2026-08-23 while preserving the existing preview-confirm-execute safety boundary.

## Scope

- Extend the daily renewal MCP preview input with optional `renewalDate` and `paymentStartDate` ISO business dates.
- Persist both dates in the renewal proposal so execute cannot silently substitute the server's current date.
- Use the dates for renewal composition, replacement loan `startDate`, replacement loan `paymentStartDate`, and generated schedule due dates.
- Keep existing clients backward compatible: omitted dates retain current behavior, with the effective renewal date derived from the Bangkok business date at preview time and the payment start date left to the existing schedule default.
- Synchronize backend REST/MCP schemas, plugin contract, renewal skill guidance, eval fixtures, validator expectations, and tests.

## Invariants and validation

1. `renewalDate` and `paymentStartDate`, when supplied, use `YYYY-MM-DD` and Asia/Bangkok business-date semantics.
2. `renewalDate` must be on or after the old loan `startDate` and must not be in the future relative to the Bangkok business date at preview time.
3. `paymentStartDate` must be on or after `renewalDate`. It may be the same day or any later date; the system must not assume “next day.”
4. A backdated renewal must not include or silently discard posted financial activity after `renewalDate`. Preview and execute must fail closed if the old loan has a repayment, reversal, or other renewal-relevant ledger change after the selected effective date.
5. Preview and execute must use the same frozen dates, composition, and state hash. Execute must recompute against the selected `renewalDate`, not `new Date()`.
6. The replacement loan must use `renewalDate` as `startDate` and `paymentStartDate` as its payment-start input. The first generated due date must reflect the latter.
7. Money remains exact two-decimal strings; no JavaScript floating-point arithmetic is introduced.
8. Existing renewal rows created before this change remain readable and executable through a compatibility fallback derived from the persisted composition's renewal date; their payment-start date remains unset so their historical schedule behavior is preserved.

## Data model

Add nullable date columns to `loan_renewals`:

- `renewal_date`: the frozen effective date for settlement/replacement start.
- `payment_start_date`: the frozen date from which replacement installments begin; nullable for legacy renewals.

New previews always populate both values. Legacy rows use the composition `renewalDate` for `renewal_date` when available and preserve the prior generator behavior when `payment_start_date` is null. The preview snapshot/hash must include both fields and the selected dates.

## Service flow

`previewLoanRenewal` accepts the two optional dates, resolves defaults once, validates them against the old loan and current Bangkok business date, and builds the renewal snapshot as of `renewalDate`. The snapshot must consider only ledger activity on or before the selected date and must record enough full ledger state to detect later activity during execute.

`executeLoanRenewal` loads the frozen dates from the renewal row, re-runs the same snapshot as of `renewalDate`, checks the preview hash/state, and generates the replacement schedule with:

```ts
generateLoanSchedule({
  ...existingTerms,
  startDate: renewalDate,
  paymentStartDate: paymentStartDate ?? undefined,
});
```

The created replacement loan stores `startDate = renewalDate` and `paymentStartDate = paymentStartDate` when present. Audit payloads and public preview/execute responses expose both dates.

## MCP and plugin contract

`renewal.preview` adds optional closed fields:

```json
{
  "renewalDate": "2026-08-22",
  "paymentStartDate": "2026-08-23"
}
```

The output adds non-null `renewalDate` and nullable `paymentStartDate`. `renewal.execute` remains unchanged because it executes the immutable preview identified by `renewalPublicId` and `previewHash`. Plugin instructions must tell agents to show both dates and stop if either date is missing or differs from the operator's requested dates.

## Compatibility and errors

- Omitted dates preserve current behavior.
- Invalid date formats: `INVALID_RENEWAL_DATE`.
- Renewal before the old loan start: `RENEWAL_DATE_BEFORE_LOAN_START`.
- Future renewal date: `RENEWAL_DATE_IN_FUTURE`.
- Payment start before renewal: `PAYMENT_START_DATE_BEFORE_RENEWAL`.
- Activity after selected renewal date: `RENEWAL_DATE_AFTER_POSTED_ACTIVITY`.
- Execute with a changed date/state: existing stale-preview behavior, with the date mismatch represented in the frozen hash/state failure.

## Testing and verification

- Unit/service tests first cover explicit dates, independent payment start date, invalid ordering, future dates, backdated post-activity rejection, legacy fallback, preview/execute date freezing, and generated first due date.
- MCP server tests cover closed input/output schemas and backward-compatible omission.
- Plugin contract tests, validator, renewal skill, and evals cover the new explicit-date confirmation boundary.
- Run the disposable PostgreSQL backend suite and typecheck, plugin tests/validator, and relevant frontend tests/build if the UI exposes renewal dates in the same change.

## Non-goals

- No automatic change to existing executed renewals.
- No browser-side accounting calculation.
- No change to settlement policy, cash direction confirmation, evidence requirements, or reversal semantics.
