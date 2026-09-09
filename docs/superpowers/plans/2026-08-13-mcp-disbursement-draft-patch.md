# MCP Disbursement Draft PATCH Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add and deploy a strict audited `loan.disbursement.update` MCP PATCH tool for editable disbursement drafts.

**Architecture:** Register one additive MCP tool that validates a non-empty closed `changes` object and delegates to the existing row-locked `updateDisbursementDraft` service. Protect the behavior with stateless contract and disposable-PostgreSQL adapter tests, then synchronize plugin 2.4.0 skills, evals, documentation, validator metadata, and the frozen 41-tool contract.

**Tech Stack:** Bun, TypeScript, Zod 4, MCP SDK, Drizzle/PostgreSQL 18, CreditSync executable plugin evals, Docker Compose.

## Global Constraints

- PATCH changes only supplied draft fields; same-field concurrent edits are last-writer-wins under the existing row lock.
- Posted and reversed disbursement events remain immutable and return `DISBURSEMENT_LOCKED`.
- Evidence IDs are never accepted by PATCH; evidence remains `prepare -> PUT -> finalize`.
- MCP schemas stay closed and expose only public UUIDs and exact decimal strings.
- Agents must re-list after update and obtain fresh explicit confirmation before post.
- No database migration and no stale-state token.
- Update `CHANGELOG.md` before every commit; update README in the implementation commit because the public MCP/plugin workflow changes.

---

### Task 1: Register the strict MCP PATCH tool

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces tool name `loan.disbursement.update`.
- Input: `{ disbursementPublicId: string; changes: UpdateDisbursementDraftInput }` with at least one closed PATCH field.
- Output: existing `disbursementEventOutput`.

- [ ] Add failing server contract assertions that the tool is advertised between draft and evidence tools, has `{readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:false}`, accepts a one-field amount PATCH, and rejects empty changes, `evidenceFilePublicIds`, `status`, and unknown fields.
- [ ] Run `cd backend && bun test src/mcp/server.test.ts`; observe failure because the tool is absent.
- [ ] Add the tool name, `toolDataSchemas` mapping to `disbursementEventOutput`, strict non-empty PATCH input schema, destructive set membership, description, and handler typing registration.
- [ ] Re-run the server test and typecheck; expect exit 0.

### Task 2: Connect the real adapter and immutable-draft service

**Files:**
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/default.test.ts`

**Interfaces:**
- Consumes `updateDisbursementDraft(ctx, disbursementPublicId, changes)`.
- Produces the updated draft with untouched fields and finalized evidence public UUIDs preserved.

- [ ] Add a disposable-PostgreSQL MCP test that creates a draft, finalizes evidence, PATCHes only `loanAttributedAmount` plus the required variance note, verifies other fields/evidence remain, inspects the `draft_updated` audit before/after payload, posts it, and verifies a later update returns `DISBURSEMENT_LOCKED`.
- [ ] Run `backend/scripts/test-disposable-postgres.sh src/mcp/default.test.ts`; observe failure because the default adapter lacks the new handler.
- [ ] Import `updateDisbursementDraft` and `UpdateDisbursementDraftInput`; add the default handler that passes only `input.changes` and the public event UUID.
- [ ] Re-run the disposable suite; expect all cases to pass serialized.

### Task 3: Synchronize plugin 2.4.0 orchestration and evals

**Files:**
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/skills/creditsync/SKILL.md`
- Modify: `plugins/creditsync/skills/manage-disbursements/SKILL.md`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/tests/eval-harness.test.ts`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `README.md`

**Interfaces:**
- Produces plugin 2.4.0 with 8 skills and 41 tools.
- Produces update workflow `list -> exact draft -> update -> list -> fresh confirmation -> post`.

- [ ] Add failing plugin/eval expectations for version 2.4.0, 41 tools, a positive draft correction that re-lists before post, and negative stopped flows for locked edits and unsupported evidence/status patch fields.
- [ ] Run plugin contract/eval tests and observe expected failures.
- [ ] Update skill instructions, root routing, executable scenario catalog/harness, manifest/readmes/changelogs, and validator constants/output.
- [ ] Ensure any confirmation before PATCH is declared invalid and evidence mismatch requires human review after re-list.

### Task 4: Freeze contract, verify, commit, and deploy

**Files:**
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `CHANGELOG.md`
- Verify all implementation files.

**Interfaces:**
- Produces canonical 41-tool contract and production backend advertisement.

- [ ] Run plugin contract test before regeneration and observe frozen-contract mismatch.
- [ ] Run `bun run plugins/creditsync/scripts/mcp-contract.ts --write`; inspect that the diff adds only the new tool plus intended metadata changes.
- [ ] Run fresh verification: disposable MCP adapter suite, backend server tests, backend typecheck, full backend non-DB suite, plugin contract/eval tests, and plugin validator.
- [ ] Update the root changelog Fixed/Added entries and README MCP/plugin version/count statements.
- [ ] Commit implementation with code, tests, generated contract, plugin docs/metadata, README, and changelogs.
- [ ] Cherry-pick the design, plan, and implementation commits onto the production `main` checkout without touching unrelated frontend changes.
- [ ] Rebuild only backend with `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d backend`.
- [ ] Verify startup/migration logs, internal MCP health 200, and read-only `tools/list` exposure of `loan.disbursement.update`; do not mutate a production draft solely for testing.
