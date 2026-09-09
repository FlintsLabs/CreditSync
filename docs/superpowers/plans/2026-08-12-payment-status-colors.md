# Payment Status Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every known Payment Inbox status an accessible, distinct semantic badge tone.

**Architecture:** Keep the status-to-tone mapping as a small pure function beside `PaymentInboxList`, and let the list consume the returned class string while retaining the existing badge structure and translated label.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, react-i18next, Vitest, Testing Library.

## Global Constraints

- Preserve visible translated status text; color must not become the only state signal.
- Support light and dark mode with paired background, text, and border classes.
- Unknown statuses use the neutral fallback.
- Do not change Payment Inbox API or financial behavior.

---

### Task 1: Semantic Payment Inbox status tones

**Files:**
- Modify: `frontend/src/pages/dashboard/payments/PaymentInboxList.tsx`
- Test: `frontend/tests/payment-inbox.vitest.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `paymentStatusTone(status: string): string`, consumed by the row badge.

- [ ] **Step 1: Write the failing test**

Render one paginated page containing `draft`, `needs_review`, `ready`, `posted`, `reversed`, and `duplicate`. Assert each translated badge exposes `data-status-tone` with the literal values `neutral`, `warning`, `success`, `info`, `danger`, and `duplicate` respectively.

- [ ] **Step 2: Run the focused test and verify RED**

Run `cd frontend && bun run test -- tests/payment-inbox.vitest.tsx`. Expected: FAIL because status tone markers and per-status colors do not exist.

- [ ] **Step 3: Implement the minimal mapping**

Export a pure mapping function returning complete Tailwind light/dark background, text, and border classes for each known status. Add `data-status-tone` to the badge and retain neutral classes for unknown states.

- [ ] **Step 4: Run focused verification and verify GREEN**

Run `cd frontend && bun run test -- tests/payment-inbox.vitest.tsx`. Expected: all Payment Inbox tests pass.

- [ ] **Step 5: Run full frontend verification**

Run `cd frontend && bun run test -- --reporter=dot`, `bun run lint`, and `bun run build`. Expected: all tests pass, lint has no errors, and production build exits zero.

- [ ] **Step 6: Document and commit**

Add a v0.3.10 `Changed` changelog bullet for semantic Payment Inbox status badges, stage the test/component/changelog, and commit `feat: color payment inbox statuses`.
