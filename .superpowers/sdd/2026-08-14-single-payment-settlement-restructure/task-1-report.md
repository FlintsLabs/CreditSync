# Task 1 Report: Exact Single-Payment and Settlement Kernel

## Implementation

- Created `backend/src/lib/single-payment.ts` with closed repayment-policy, retroactive-rate, and late-penalty unions; it normalizes public money strings with `decimal.js`, validates Bangkok business dates, and requires a due date later than the loan start date.
- Added `calculateSinglePaymentSettlement()` with exact Decimal-only fixed and retroactive candidates, an exposure/day trace, deterministic fixed-on-equality selection, concurrent contracted late-penalty calculation, component waivers, and gross/net settlement components.
- Added `single_payment` to the calculator repayment union and produces one immutable maturity row whose interest is the agreed fixed amount. `loan-schedule.ts` now passes single-payment terms through to the calculator.

## Test-first Evidence

1. Added `single-payment.test.ts` and the one-row public-schedule case before creating the implementation module.
2. Ran `bun test src/lib/single-payment.test.ts src/lib/public-loan-terms.test.ts` from `backend/`.
   - Observed the intended RED state: `Cannot find module './single-payment'` and `Repayment type is not supported` for `single_payment`.
3. Implemented the smallest calculation and schedule support needed for the cases.
4. Ran `bun test src/lib/single-payment.test.ts src/lib/public-loan-terms.test.ts src/lib/public-loan-schedule.test.ts`.
   - Result: 11 pass, 0 fail.
5. Ran `bun run typecheck` from `backend/`.
   - Result: pass (`tsc --noEmit`).

## Self-review

- All public money inputs in the kernel use `parseMoney()` and every public amount result uses `serializeMoney()`.
- Interest candidates are alternatives: the kernel selects `max(fixed, retroactive)` and uses the fixed branch for equality; it never adds the two candidates.
- Exposure dates are validated `YYYY-MM-DD` calendar dates and arithmetic uses exact whole Bangkok business days. Penalties begin only after due date plus grace days.
- The requested test cases cover fixed-only normalization, mutually exclusive policy rejection, due-date validation, both `max()` branches, equality, reduced principal exposure segments, penalty, waiver, and the exact one-row schedule.
- Scope is limited to the five Task 1 library/test files plus the required changelog and this report. No production workflow, persistence, REST, MCP, or UI integration was changed; those remain follow-on tasks.

## Fix Round 1: Review Corrections

### Changes

- Replaced the optional retroactive field on normalized terms with a discriminated `SinglePaymentTerms` union. Settlement now consumes `terms` from that normalized activated contract and derives both retroactive-interest and late-penalty policy exclusively from it.
- Added an authoritative retroactive-exposure timeline guard: retroactive intervals must be positive-duration, contiguous, non-overlapping, and end exactly on the settlement date. A final explicit `0.00` interval is accepted to represent a fully repaid balance through settlement.
- Closed `normalizePublicLoanTerms()` for single-payment inputs: it now requires and validates a `YYYY-MM-DD` start date and returns normalized fixed interest, retroactive rate, penalty, and policy data.
- Validated public schedule start dates before constructing a `Date`, and formats direct `Date` inputs using `Asia/Bangkok` for maturity validation rather than UTC.

### Test-first Evidence

1. Added focused regressions in `backend/src/lib/single-payment.test.ts` and `backend/src/lib/public-loan-terms.test.ts` before the correction.
2. Ran `cd backend && bun test src/lib/single-payment.test.ts src/lib/public-loan-terms.test.ts`.
   - RED result: 9 pass, 4 fail. The kernel accepted a timeline ending `2026-08-20` for a `2026-08-24` settlement, selected `700.00` retroactive interest despite an injected `fixed_only` policy, returned unvalidated single-payment public terms, and accepted an equal Bangkok start/due date after UTC conversion. The positive-grace boundary itself already passed (`lateDays: 1`, `grossPenalty: "20.00"`).
3. Ran `cd backend && bun test src/lib/single-payment.test.ts src/lib/public-loan-terms.test.ts && bun run typecheck` after the correction.
   - GREEN result: 16 pass, 0 fail; `tsc --noEmit` passed.

### Self-review

- A fixed-only term cannot expose a retroactive policy through the normalized TypeScript union; the runtime calculation also ignores injected retroactive properties on that branch.
- The retroactive branch fails closed without an authoritative exposure timeline and validates coverage to the settlement boundary, including gaps and overlaps.
- Public term normalization no longer returns raw single-payment money/policy values. The public schedule accepts only date strings; direct schedule calculations derive their comparison date from Bangkok time.
