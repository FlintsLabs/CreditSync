# Loan-list payment-health indicator design

**Date:** 2026-08-11
**Status:** Approved for implementation

## Purpose

Make overdue borrower obligations visible on the loan-agreement list before an operator opens a loan. The indicator is a compact payment-health signal on each clickable loan card, not a disruptive alert. It applies to fixed-schedule daily, weekly, and monthly loans and to open-ended floating daily-interest loans.

Loan lifecycle status and payment health remain separate concepts. For example, a loan may remain `active` while its payment health is `overdue`.

## Payment-health contract

Extend the loan-list response with a backend-owned `paymentHealth` object:

```ts
type LoanPaymentHealth = {
    status: "current" | "due_today" | "overdue" | "settled";
    dueTodayAmount: string;
    overdueAmount: string;
    overdueItemCount: number;
    maxOverdueDays: number;
};
```

All money fields are two-decimal decimal strings. The backend calculates and aggregates them with `decimal.js`; the frontend must not recreate accounting calculations or convert these values through JavaScript `Number`.

The states mean:

- `current`: the loan has no unpaid amount currently due.
- `due_today`: an unpaid amount is currently due, but nothing has crossed the effective overdue boundary. This includes an installment inside its configured grace period.
- `overdue`: at least one payable item from an earlier effective due date remains unpaid after any configured grace period.
- `settled`: the loan lifecycle is paid/closed and no payable amount remains.

If an older overdue item and a current-day item coexist, `status` is `overdue`, `overdueAmount` contains only overdue amounts, and `dueTodayAmount` contains only the current-day amount.

## Fixed-schedule loans

For daily, weekly, and monthly loans, compute health from the immutable loan schedule and the existing overdue policy. An item is overdue when its effective overdue days are greater than zero and its remaining due plus unpaid penalty is greater than zero. `overdueAmount` is the exact sum of each overdue row's `totalDueNow`; `overdueItemCount` is the number of overdue installments; and `maxOverdueDays` is the greatest overdue age.

An installment due on the current Bangkok date contributes to `dueTodayAmount` but is not overdue. A still-unpaid installment inside its configured grace period also contributes to `dueTodayAmount`; the field means “due now and not overdue,” rather than “dated today only.” Configured grace-period behavior remains authoritative: a schedule row does not become overdue until the existing overdue calculation says its effective overdue days are positive.

## Floating daily-interest loans

Floating loans are open-ended daily products even though they do not have fixed installment schedules. Before computing payment health, the backend brings the existing floating-interest accrual ledger current through the present Bangkok business date using the established idempotent accrual service.

An unpaid floating-interest accrual dated today contributes to `dueTodayAmount`. It becomes overdue only on the following Bangkok business date if an amount remains unpaid. Earlier partially paid accruals contribute only their exact unpaid remainder. For floating loans, `overdueItemCount` counts overdue accrual dates and `maxOverdueDays` is the age of the oldest unpaid accrual date.

The indicator does not invent a principal due date for a floating loan. Outstanding floating principal remains visible as the existing loan balance but is not counted as overdue without an explicit dated payable record.

## Backend organization and data flow

Add a focused payment-health service that owns the shared DTO and calculations. The loan-list route supplies accessible loans and their tenant-scoped schedule/accrual data to this service, then returns each existing loan summary with `paymentHealth`. The list remains one frontend request; the UI must not issue per-card schedule or accrual calls.

The service uses `Asia/Bangkok` to derive the business date and `decimal.js` for all money operations. Tenant and owner access filters remain unchanged. Existing lifecycle fields, exact-money serialization, and public UUIDs remain backward compatible.

The existing short loan-list cache may retain a just-crossed-midnight state for at most its configured 30-second TTL. No schema migration is required because schedule and floating-accrual ledgers already contain the source data.

## Loan-card presentation

Keep the existing lifecycle status on each card. Add a separate, localized payment-health treatment near the outstanding balance:

- `overdue`: destructive/red badge with an alert icon. Scheduled loans show “Overdue {{count}} installments”; floating loans show “Overdue {{count}} days”. A secondary line shows the exact overdue amount and “up to {{days}} days overdue”.
- `due_today`: amber/secondary badge with a clock or calendar icon and the exact amount currently due, using localized “Due now” copy.
- `current`: no payment-health badge.
- `settled`: no overdue treatment.

The treatment must use text and an icon as well as color, remain legible in both themes, and preserve the full-card link to loan detail. English and Thai copy are added together. The displayed money uses the existing exact-money formatter and active application language.

## Detail-page consistency

On loan detail, render overdue schedule status with the same localized destructive badge instead of raw lowercase `overdue` text. The list indicator is the navigation cue; the detail schedule remains the source for installment-level inspection. Floating-loan accrual details continue to use the existing accrual-ledger behavior and are not replaced by a fabricated installment schedule.

## Error and compatibility behavior

The loan list must fail as it does today if its authoritative payment-health calculation cannot be loaded; it must not silently label an unknown financial state as current. Draft loans without payable records return `current`. Legacy floating loans without a configured daily-interest policy return `current` and do not generate synthetic accruals.

The change is additive to the REST response. It does not change loan terms, schedules, payment posting, allocations, penalties, MCP contracts, or immutable financial records.

## Verification

Backend tests cover scheduled current/due-today/overdue/grace-period/partial/paid cases, exact decimal aggregation, tenant isolation, and floating accruals for today versus the following Bangkok day. They also verify that floating principal alone is not treated as overdue and that repeated reads do not duplicate accruals.

Frontend component tests cover red overdue and amber due-today treatments, scheduled installment versus floating-day copy, exact large-value formatting without `Number`, lifecycle/payment-health separation, card navigation, and English/Thai localization. Verification includes backend focused tests and typecheck, frontend focused tests, lint, and production build.
