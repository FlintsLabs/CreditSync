# Intermediary Remittance Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the existing intermediary ledger with historical payment linking, remittance evidence, MCP/UI access, and production deployment.

**Architecture:** Extend the current intermediary service and schema rather than duplicating payment intakes. A historical collection references a validated existing intake; remittance posting skips payment creation for that collection while retaining immutable provenance.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, React/Vite, MCP SDK, MinIO.

## Global Constraints

- THB values are exact two-decimal strings calculated with `decimal.js`.
- Financial history is append-only and tenant scoped.
- Evidence uses prepare → signed PUT → finalize.
- MCP calls services directly and requires explicit confirmation for post.
- Update English and Thai copy, README, CHANGELOG, plugin contract/version, and deployment verification.

---

### Task 1: Historical collection links

- [ ] Write a failing disposable-PostgreSQL test proving a posted intake can be linked once and remittance posting creates no second transaction.
- [ ] Run the focused test and observe the missing API/schema failure.
- [ ] Add the additive schema constraint and service command with exact borrower/loan/amount/date validation.
- [ ] Run the focused and full intermediary suites.

### Task 2: Remittance evidence lifecycle

- [ ] Write failing schema/service/route tests for prepare/finalize/list and immutable finalized links.
- [ ] Run tests and observe the missing evidence behavior.
- [ ] Implement storage intents and REST endpoints using the existing secure file lifecycle.
- [ ] Run focused tests and typecheck.

### Task 3: MCP and plugin contract

- [ ] Write failing MCP registration and plugin contract tests for intermediary/remittance tools.
- [ ] Register closed-schema handlers and annotations calling the service directly.
- [ ] Add the remittance skill/evals and regenerate the frozen contract.
- [ ] Run MCP and plugin validators.

### Task 4: Manual Web workspace

- [ ] Write failing localized component tests for list, exact balance, evidence state, and confirmation.
- [ ] Add the route, navigation, API types, page, and synchronized locale copy.
- [ ] Run frontend tests, lint, and build.

### Task 5: Release, migrate, reconcile, and deploy

- [ ] Update README and CHANGELOG under a new dated version.
- [ ] Run disposable backend tests, typecheck, frontend verification, and plugin verification.
- [ ] Commit the complete staged change set.
- [ ] Deploy infra/app, verify migration tables/columns, backend logs/MCP health, and public frontend.
- [ ] Use the deployed MCP workflow to create the confirmed intermediary and reconcile the three supplied 180-baht slips without double posting.
