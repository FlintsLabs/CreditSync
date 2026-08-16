# CreditSync Slip Evidence Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make supplied payment-slip images a mandatory, verified evidence prerequisite for CreditSync payment posting while retaining the existing data-only path when no image is supplied.

**Architecture:** Keep the MCP contract and backend unchanged. Encode the rule in the `reconcile-payments` orchestration skill and root plugin guidance, then prove it with the existing scripted MCP harness: image flows must prepare/upload/finalize before preview/post, while data-only flows skip evidence. Add negative fixtures for every evidence stop boundary that must prevent financial posting.

**Tech Stack:** Markdown skills/docs, TypeScript Bun scripted-MCP harness, Bun tests, JSON eval catalog, existing CreditSync MCP contract.

## Global Constraints

- Supplied images require `evidence.prepare → unchanged-byte PUT → evidence.finalize` before `payment.preview` or `payment.post`.
- No supplied image means data-only capture remains valid and must not manufacture evidence.
- Hard intake/evidence duplicates, missing or expired upload descriptors, upload/finalize failures, checksum/metadata mismatches, and non-ready evidence stop before preview/post.
- The backend remains authoritative for borrower matching, allocation, money, and posting readiness; do not add agent-side accounting.
- Do not change the frozen MCP tool contract, backend service, or plugin manifest version.
- Never log signed URLs, raw QR payloads, evidence contents, bearer tokens, or full private tool payloads.
- Preserve unrelated dirty files and stage only files belonging to this feature in each commit.

---

### Task 1: Harden the payment reconciliation instructions

**Files:**
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/skills/creditsync/SKILL.md`
- Modify: `plugins/creditsync/README.md`
- Test: `plugins/creditsync/tests/operations-docs.test.ts`

**Interfaces:**
- Consumes: the existing `intake.create`, `evidence.prepare`, `evidence.finalize`, `payment.preview`, and `payment.post` MCP sequence.
- Produces: explicit operator guidance distinguishing `hasSlipImages` from data-only capture and a documented fail-closed post gate.

- [ ] **Step 1: Add failing documentation assertions**

Add tests that read the payment skill/root skill/plugin README and assert they state all of the following: supplied image means evidence is mandatory; evidence must be ready before preview/post; failed or unavailable evidence stops; no-image data-only capture remains supported; and signed URLs are never exposed.

- [ ] **Step 2: Run the focused documentation test and verify it fails**

Run: `cd plugins/creditsync && bun test tests/operations-docs.test.ts`

Expected: FAIL because the current docs do not contain the new hard-gate wording in every required surface.

- [ ] **Step 3: Update the payment skill and root guidance**

Make the image-first section normative: branch on whether the user supplied images, calculate exact local metadata, prepare and inspect every evidence item, PUT unchanged bytes with required headers, finalize, verify `ready` plus identity/MIME/size/SHA-256 binding, and only then preview/post. State that data-only requests skip all evidence calls. Add the same rule to the root orchestration overview and README operational behavior without changing unrelated workflows.

- [ ] **Step 4: Run the focused documentation test and verify it passes**

Run: `cd plugins/creditsync && bun test tests/operations-docs.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the documentation change**

Before committing, add a concise `### Changed` entry under `## v0.3.14 - 2026-08-16` in `CHANGELOG.md` describing the enforced conditional slip-evidence ordering. Then run `git diff --check` and commit only the docs, skill, test, and changelog files:

```bash
git add CHANGELOG.md plugins/creditsync/README.md plugins/creditsync/skills/creditsync/SKILL.md plugins/creditsync/skills/reconcile-payments/SKILL.md plugins/creditsync/tests/operations-docs.test.ts
git commit -m "docs: enforce conditional payment slip evidence"
```

### Task 2: Add executable positive payment-flow assertions

**Files:**
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/tests/eval-harness.test.ts`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`

**Interfaces:**
- Consumes: `paymentFlow(mcp, { evidence?: boolean, explicitAllocations?: ... })` and `ScriptedMcp.uploadEvidence` side-effect capture.
- Produces: executable scenarios proving data-only calls never touch evidence and slip calls upload unchanged bytes before matching/posting.

- [ ] **Step 1: Add failing assertions for both branches**

Extend the eval tests to assert `payment-data-only` has exactly `intake.create → payment.preview → payment.post` with no evidence side effect, and `payment-slip` has exactly `intake.create → evidence.prepare → evidence.finalize → payment.preview → payment.post` plus one unchanged `evidence.put` effect whose byte length and SHA-256 match the fixture. Also assert the catalog contains both scenarios and their expected call/effect declarations.

- [ ] **Step 2: Run the focused eval tests and verify the new assertions fail if the contract is not explicit**

Run: `cd plugins/creditsync && bun test tests/eval-harness.test.ts tests/plugin-contract.test.ts`

Expected: Existing positive behavior should pass; the newly added wording/ordering assertions should identify any missing exact contract expectation before implementation changes.

- [ ] **Step 3: Make the scripted slip scenario model supplied-image intent explicitly**

Keep `paymentFlow` branching only on `options.evidence`. In the slip scenario fixture, retain `evidence.prepare` and `evidence.finalize` before preview/post, and ensure the scripted adapter records a single `evidence.put` with unchanged fixture bytes and declared hash/size. Keep `payment-data-only` without evidence calls or effects. Do not add backend or contract fields.

- [ ] **Step 4: Run the focused eval tests and verify they pass**

Run: `cd plugins/creditsync && bun test tests/eval-harness.test.ts tests/plugin-contract.test.ts`

Expected: PASS, including exact call order, catalog order, and upload metadata.

- [ ] **Step 5: Commit the positive eval coverage**

```bash
git add plugins/creditsync/evals/harness.ts plugins/creditsync/evals/evals.json plugins/creditsync/tests/eval-harness.test.ts plugins/creditsync/tests/plugin-contract.test.ts
git commit -m "test: cover conditional payment slip evidence"
```

### Task 3: Add fail-closed evidence stop scenarios

**Files:**
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/tests/eval-harness.test.ts`

**Interfaces:**
- Consumes: the same `paymentFlow` evidence branch and scripted MCP error fixtures.
- Produces: negative eval scenarios that stop before `payment.preview` and `payment.post` whenever supplied evidence cannot be safely finalized.

- [ ] **Step 1: Add failing scenario catalog/tests**

Add scenarios for: `evidence.prepare` returning a hard duplicate; prepare returning no current upload URL/headers; and finalize returning a binding/checksum mismatch. Each catalog entry must list the exact calls through the stop point, forbid `payment.preview` and `payment.post`, and declare expected/forbidden upload effects. Add test assertions that the result is stopped and no financial post occurs.

- [ ] **Step 2: Run the focused negative tests and verify the scenarios expose missing stop behavior**

Run: `cd plugins/creditsync && bun test tests/eval-harness.test.ts`

Expected: FAIL until `paymentFlow` converts each evidence failure into a deterministic stop result and does not continue to preview/post.

- [ ] **Step 3: Implement the minimal fail-closed branches**

In `paymentFlow`, after `evidence.prepare`, stop on `duplicate === true` after inspecting the returned original intake; stop when `uploadUrl` is absent or required headers are unavailable; and after finalize, require a successful ready result with the expected evidence identity and file metadata available from the fixture. Never call preview/post after any branch. Preserve the existing data-only branch unchanged.

- [ ] **Step 4: Run the focused negative tests and validator**

Run: `cd plugins/creditsync && bun test tests/eval-harness.test.ts && bun run validate`

Expected: PASS with no forbidden post calls/effects and no catalog/harness mismatch.

- [ ] **Step 5: Commit the fail-closed eval coverage**

```bash
git add plugins/creditsync/evals/harness.ts plugins/creditsync/evals/evals.json plugins/creditsync/tests/eval-harness.test.ts
git commit -m "test: stop payment posting when slip evidence fails"
```

### Task 4: Complete verification and handoff

**Files:**
- Verify: all files changed by Tasks 1–3
- Verify: `plugins/creditsync/scripts/validate.ts`, `plugins/creditsync/references/mcp-tool-contract.json`

**Interfaces:**
- Consumes: completed conditional evidence workflow and all scripted eval catalog entries.
- Produces: verified plugin package with unchanged MCP contract and preserved unrelated worktree changes.

- [ ] **Step 1: Run the complete plugin test suite**

Run: `cd plugins/creditsync && bun test`

Expected: PASS.

- [ ] **Step 2: Run plugin validation and contract checks**

Run: `cd plugins/creditsync && bun run validate && python3 /home/flintstone/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/creditsync`

Expected: PASS or the documented non-live private-app placeholder warning only; no contract drift.

- [ ] **Step 3: Inspect the final diff and worktree ownership**

Run: `git diff --check && git status --short && git diff HEAD~3..HEAD --stat`

Expected: only the intended plugin/docs/changelog changes are in the feature commits; pre-existing `AGENTS.md` and unrelated docs remain untouched.

- [ ] **Step 4: Commit any required final changelog correction**

If verification reveals a missing summary, update the existing version/date heading and commit the changelog together with the correction. Do not create a changelog-only follow-up for an already-described change.

- [ ] **Step 5: Report the result**

Report the conditional behavior, exact verification commands/results, unchanged MCP contract, commit IDs, and any known limitation (for example, the plugin marketplace installation must be refreshed before a new Codex task sees the updated skill).

