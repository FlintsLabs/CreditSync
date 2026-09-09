# Weekly Floating Interest Regression Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock down the weekly floating-loan behavior for advance interest, next collection dates, and exact weekly interest amounts.

**Architecture:** Extend the existing pure financial-policy tests around `interestPeriodFor`, `calculatePeriodInterest`, and `calculateAccruedInterest`. The tests will model the reported contract (`5,000.00`, `12%`, weekly, one period collected in advance) without touching the database or posting financial records.

**Tech Stack:** Bun, TypeScript, `bun:test`, `decimal.js`-backed financial helpers.

**Spec:** The requested contract behavior from the user: advance payment covers the first weekly period; the next collection is the next anchored weekly period; interest is calculated as 12% of principal per seven-day period with exact two-decimal money output.

## Global Constraints

- Money remains decimal strings and calculations remain in the backend financial helpers.
- Weekly periods use half-open date ranges `[start, nextStart)`.
- Advance interest is non-refundable and does not silently alter principal.
- Tests remain read-only and must not post or mutate financial records.

---

### Task 1: Add regression coverage for the reported weekly contract

**Files:**
- Modify: `backend/src/lib/floating-interest-policy.test.ts`
- Test: `backend/src/lib/floating-interest-policy.test.ts`

**Interfaces:**
- Consumes: `normalizeFloatingInterestPolicy`, `interestPeriodFor`, `calculatePeriodInterest`, and `calculateAccruedInterest`.
- Produces: executable assertions for the exact contract scenario.

- [ ] **Step 1: Write the failing test**

Add a test using a normalized policy with `periodUnit: "week"`, `rateMode: "percent"`, `rate: "12"`, and `advanceInterestPeriods: 1`. Assert that the first period starts on `2026-08-13`, ends/collects on `2026-08-20`, and that the next collection period starts on `2026-08-20` and ends on `2026-08-27`. Assert `calculatePeriodInterest("5000.00", policy) === "600.00"`, seven-day accrued interest is `"600.00"`, and the advance payout is `"4400.00"` using decimal-safe expectations.

Use a separate assertion for the following period so a regression that accidentally keeps charging the first period or shifts the boundary is visible.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun test backend/src/lib/floating-interest-policy.test.ts`

Expected: the new test should fail only if the current implementation does not expose the required scenario behavior; existing tests should still run and report their current status.

- [ ] **Step 3: Make the minimal implementation change if the test exposes a real behavior defect**

Only change `backend/src/lib/floating-interest-policy.ts` if the focused test demonstrates an incorrect period boundary or amount. Preserve the existing half-open weekly-period convention and decimal-string calculations; do not add database behavior or infer a different rate unit.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `bun test backend/src/lib/floating-interest-policy.test.ts`

Expected: all tests in the file pass with no financial values represented as JavaScript `Number` values.

- [ ] **Step 5: Run the backend library test suite**

Run: `bun test backend/src/lib`

Expected: all library tests pass, including existing daily, monthly, per-thousand, and weekly rounding coverage.

- [ ] **Step 6: Update the changelog before any commit**

If a commit is requested or created, add a concise `Fixed` or `Changed` entry under a new/current explicit version/date heading in `CHANGELOG.md`, staging it with the test/code changes. No commit is required for this task unless explicitly requested.

## Self-Review Checklist

- The test covers both advance-period dates and the next period dates.
- The test proves `12%` is applied per week, not divided into an annual/monthly rate.
- The test proves the full seven-day amount is exactly `600.00`.
- The test does not post, reverse, or mutate any payment or loan record.
- Any implementation change is minimal and supported by a failing test first.
