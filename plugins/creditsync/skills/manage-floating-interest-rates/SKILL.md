---
name: manage-floating-interest-rates
description: Use when inspecting, scheduling, previewing, or confirming an effective-dated interest-rate change for a CreditSync floating loan.
---

# Manage floating interest rates

Use only the three `loan.interest-rate.*` tools. The backend owns date coverage, exact decimal normalization, daily-interest calculation, automatic splitting, and accrued-date protection. A rate timeline change preserves the loan's contractual day/week period policy; it does not convert or replace that origination policy.

## Required workflow

1. Call `loan.interest-rate.list` with the exact loan public UUID. Show the current period, exact daily interest, next change, and `earliestEditableDate`.
2. Collect `effectiveDate`, nullable `expiryDate`, `rateType`, and rate string. Never derive or round a rate in conversation.
3. Call `loan.interest-rate.preview`. Show the requested normalized rate, before/after timeline, superseded periods, warnings, preview identity, and expiry.
4. Obtain explicit human confirmation of the exact preview. A request to explore or preview is not confirmation to execute.
5. Call `loan.interest-rate.execute` with `confirmed: true`, the unchanged preview UUID/hash, a specific non-blank reason, and a stable idempotency key for this exact intent.
6. Report the returned timeline, audit public ID, and correlation ID. Re-list before any later change.

Rate periods may be maintained regardless of loan lifecycle status when the backend permits access, but accrued dates are immutable. Never bypass `RATE_PERIOD_ACCRUED_DATE_CONFLICT`, overlap, stale/expired preview, changed timeline, or idempotency conflict. Re-list and re-preview; prior approval does not carry over.

Do not edit the legacy loan rate field, call REST/SQL, alter accrual records, convert weekly rates to daily rates, or calculate financial results locally. Use `settle-floating-loans` for a close-out rather than treating a zero/final rate as settlement.
