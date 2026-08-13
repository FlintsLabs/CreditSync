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
