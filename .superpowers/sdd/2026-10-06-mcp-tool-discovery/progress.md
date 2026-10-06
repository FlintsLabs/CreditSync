# SDD ledger — plan: docs/superpowers/plans/2026-10-06-mcp-tool-discovery.md

User approved spec and plan on 2026-10-06 with "ok". Baseline: 0f77e82c62f558aa440ea5b46592068b117f6a2b.
Ruling: Use Codex app-managed /home/flintstone/.codex/worktrees/mcp-tool-discovery/CreditSync instead of the proposed external worktree path.
Ruling: Root supervisor preserved and removed the premature uncommitted draft after two inaccurate guidance iterations; only worker-owned source changes were restored, all approved/user documents remain intact. Evidence: /tmp/creditsync-mcp-tool-discovery-20261006/draft-round2-preserved and worker logs. No task is complete, and no RED/GREEN evidence is claimed for that draft.
Ruling: Continue through focused tmux worker assignments, one approved task per fresh CLI context, on the same feature branch and implementation model. Root retains responsibility for the complete six-task objective and independent final review.

User steering: use gpt-6-luna Speed from now on (2026-10-06). Resume with explicit service_tier="fast" (request tier priority), reasoning medium retained from the approved plan. This overrides older gpt-5.6-luna routing for this task.

Execution history: the prior delegated worker was running as gpt-5.6-luna when stopped by the supervisor. Its preserved Task 1 changes and initial tests are carried forward; no commits were created. The active worker resumes on this same worktree under gpt-6-luna Speed. Do not attribute earlier work to the new model.

Task-order ruling: initialization guidance must not advertise or invoke `tool.catalog.search` until Task 2 registers it. Task 2 must add the capability-search instruction. Task 1 must share one truthful instructions constant between transports.

Task 1 checkpoint: wrote `tool-guidance.test.ts` first. Initial RED confirmed the registry was missing; second RED confirmed premature search-tool advertising and the commission reversal's misleading idempotency-key advice. Initial green: three guidance tests passed before supervisor review. Follow-up assertions now cover keyless retries, preview/post confirmation separation, relationships, borrower conditional inputs, and non-empty real validation recovery guidance. Final gates passed after one initial timeout/typecheck correction; commit is pending.

Additive user authorization: update AGENTS.md to latest Luna + Speed/Fast. Root updated AGENTS.md in the main checkout immediately and mirrored it here. This is an intentional user-authorized main documentation change; preserve it. Include feature AGENTS.md and a matching CHANGELOG entry in the next task commit. Future workers must verify available Luna releases, explicitly set model + medium reasoning + fast tier, and avoid silently reverting to older Luna.


Task 1 completion record (2026-10-06):
- Preserved all 145 baseline MCP tool names and existing schemas/risk policy memberships. Replaced duplicate server purpose map with the guidance registry, shared truthful initialization instructions across legacy and modern transports, and made all registry nodes immutable at runtime. Guidance hash canonicalizes nested object keys and changes with meaningful content.
- User-authorized `AGENTS.md` Luna Speed routing and its matching changelog entry are included in this task commit.
- RED evidence: the initial focused guidance test failed because the registry did not exist; subsequent review regressions caught incorrect commission reversal retry advice and premature search-tool advertising.
- Verification: `bun test src/mcp/tool-guidance.test.ts` — 5 pass, 0 fail, 2,946 assertions. `bun test --timeout 15000 src/mcp/tool-guidance.test.ts src/mcp/server.test.ts src/mcp/modern.test.ts` — 53 pass, 0 fail, 3,935 assertions. `bun run typecheck` — pass. Root's first combined fixture run had one 5-second timeout on batch staging while under concurrent load; the isolated longer-timeout rerun passed.
- Plugin snapshots/validator were intentionally not run or claimed; synchronization is Task 5. No financial algorithms were changed. No unresolved Task 1 issue.

Task 2 completion record (2026-10-06):
- Implemented exactly one additional catalog name, `tool.catalog.search`, increasing the catalog from 145 to 146. Current profile definition counts are full 146, core-read 39, payments 68, loans 46, disbursements 42, and admin 37; search is present in each. Future discovery profile work remains Task 4.
- Added pure metadata ranking with normalized exact names, curated Thai/English phrases, meaningful lexical overlap, stable catalog-order tie-breaking, profile filtering, clarification/no-match/connection/refresh statuses, and bounded digest-bound cursors. Added strict public schemas, a named default handler, trusted context injection after parse, and shared initialization guidance. No domain-data read, execution, persistence, financial envelope, or audit requirement was added.
- RED evidence: first focused search-test run failed at import because the exhaustive guidance registry had no `tool.catalog.search` entry. A later transport test caught wrong expectation for the SDK's invalid-argument error shape and was corrected to assert protocol error plus zero additional handler calls.
- Verification: `bun test --timeout 15000 src/mcp/tool-catalog-search.test.ts src/mcp/tool-guidance.test.ts src/mcp/profiles.test.ts src/mcp/modern.test.ts src/mcp/server.test.ts -t 'catalog search|tool catalog search|profile-aware catalog'` — 7 pass, 0 fail, 55 assertions; this covers search pure ranking/cursors, legacy and modern success, spoof rejection, no audit envelope, and annotations/profile membership. Broader combined run before correcting the legacy SDK error assertion reported 65 pass and one assertion-shape failure; rerun of affected seven cases passed. `bun run typecheck` — pass. `git diff --check` — pass.
- Plugin contract snapshots remain intentionally stale until Task 5. No DB tests were needed; no database, production MCP, external API, or paid model was used. Task 2 source/docs/tests are ready to commit; no unresolved blocker.
