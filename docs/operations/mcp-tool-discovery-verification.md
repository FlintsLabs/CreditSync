# MCP tool discovery verification

Verification run on 2026-10-06 in the isolated `codex/mcp-tool-discovery` worktree. The application-source HEAD under test was `574b5296b2be3cfcfd0734bd0d30359dca37903d` (the Task 5 confirmation-ordering fix). Task 6 adds documentation only after these gates; the remote controller is responsible for independently repeating the required gates and recording its final-HEAD review.

## Catalog and generated references

- Catalog version: `mcp-catalog-d816cad8ed74b1d2`; workflow resolver: `workflow-resolver-1.2.0`; guidance version: `mcp-guidance-fca8a5359b51fcd4`.
- Counts derived from the serving allowlists and generated contract: full 147, core-read 38, payments 68, loans 47, disbursements 42, admin 37, discovery 8. The plugin is 12.0.0 with 11 skills.
- Regenerated the MCP contract, all seven profile snapshots, and tool guide twice. SHA-256 manifests from both generations were byte-identical; `git diff --exit-code` on the generated artifacts returned 0. The plugin validator also passed after generation.
- Deterministic metadata-search evaluation: 16 cases; expected-candidate recall 1.00; unambiguous first-choice 1.00; 0 status mismatches; 0 forbidden matches; 6/6 profile/stale safe stops. These are synthetic metadata-routing measurements, not model accuracy or token savings.
- Modern full catalog traversal measured 6 pages / 941,583 wire bytes; the eight-tool discovery profile measured 1 page / 133,182 wire bytes. This is an 85.9% reduction in measured response bytes for that run. These are serialized protocol bytes, not token counts. Legacy full traversal measured 2,614,841 bytes. Schema-generation delta during request discovery was 0.

## Verification commands

| Command | Result | Evidence / notes |
| --- | --- | --- |
| `bash backend/scripts/test-disposable-postgres.sh` | **Pass**, exit 0 | 1,291 pass markers, 0 failures, 3 cache-dependent skips, across 167 test files. The skips were `loan-list-borrower-labels`, `loan-restructures`, and `borrower-service` cache invalidation cases. The required deferral integration file executed all 3 tests: conservation/audit, concurrent replay and changed-payload conflict, and eligibility/tenant/owner stops. MCP default and resolver deferral tests also executed and passed. Disposable-only PostgreSQL; the script removed its container and volume. Full output: `/home/flintstone/.local/state/creditsync/mcp-tool-discovery-20261006/task6-backend-disposable.log`.
| `cd backend && bun run typecheck` | **Pass**, exit 0 | `tsc --noEmit`; log: `task6-backend-typecheck.log` in the state directory above. |
| `cd backend && bun run mcp:discovery:benchmark` | **Pass**, exit 0 | Complete traversal, profile counts, bytes, and schema-generation delta recorded in `task6-backend-benchmark.log`. |
| `cd backend && MCP_CONFORMANCE_ROOT=/tmp/creditsync-mcp-conformance-task6 bun run mcp:conformance` | **Blocked**, exit 1 | Pinned source checkout/package verified at `7169291ec0b68eb370fddcd9947313ab0d5e4156` / `0.2.0-alpha.11`. The synthetic local adapter/schema-dispatch check passed, but all six official scenarios could not start because the checkout has no installed `commander` package. Installing missing dependencies was outside the authorized scope. Initial invocation without `MCP_CONFORMANCE_ROOT` also failed its required configuration check. Logs: `task6-backend-conformance*.log`; checkout log: `task6-conformance-checkout.log`. No conformance scenario pass is claimed. |
| `cd frontend && bun run test` | **Pass**, exit 0 | 67 files, 316 tests passed. The runner printed a non-failing navigation-not-implemented notice. |
| `cd frontend && bun run lint` | **Pass**, exit 0 | ESLint completed with no reported findings. |
| `cd frontend && bun run build` | **Pass with warning**, exit 0 | TypeScript and Vite production build completed. Vite reported the existing minified JS chunk is over 500 kB. |
| `bun test plugins/creditsync/tests` | **Pass**, exit 0 | 61 tests, 1,955 assertions. |
| `bun run plugins/creditsync/scripts/validate.ts` | **Pass**, exit 0 | Plugin 12.0.0, 11 skills, 147 tools; no bundled MCP/secrets; private app remains a non-live placeholder. Rerun after regeneration also passed. |
| `bun run plugins/creditsync/scripts/evaluate-discovery.ts` | **Pass**, exit 0 | 16 deterministic synthetic cases and metrics above. `modelEvaluation` is `not_run`; no sanitized recorded model traces were supplied. |
| `git diff --check 0f77e82c62f558aa440ea5b46592068b117f6a2b..574b5296b2be3cfcfd0734bd0d30359dca37903d` | **Pass** | No whitespace errors in the implementation diff. |

The complete task log and individual command outputs are outside Git under `/home/flintstone/.local/state/creditsync/mcp-tool-discovery-20261006/`. The official conformance runner is the only blocked gate; its missing external dependency was not installed. No assertions or hard cases were removed to obtain these results.

## Safety review

The final source review checked closed input/output schemas, server-selected profile/catalog/guidance context, metadata-only search and targetless help, profile and related-tool filtering, cursor snapshot binding, Thai/English phrase distinctions, and request metrics that exclude input arguments. Financial command schemas remain operation-specific; there is no generic executor. Search/help do not read borrower or financial records, persist previews, add audit records, or invoke command handlers.

Schedule deferral delegates to the existing service. The service scopes rows to the command tenant, rechecks owner access and current loan/schedule eligibility, locks before execution/replay, requires the same idempotency payload, preserves installment amounts/count, and requires its linked audit on replay. Resolver guidance only inspects authoritative state and requests explicit human confirmation; it does not set confirmation or execute. Money remains decimal-string data and service-owned financial calculations; no financial floating-point calculation was added.

`loan.cancel.preview` is accurately documented as a persisted, non-idempotent preview with a state change, and it is not presented as read-only. Documentation does not claim that CreditSync implements provider-hosted deferred loading, host tool search, dynamic notifications, or `listChanged` publication. Provider-native features require support in the connected host.

## Live and client acceptance boundaries

The pre-change source baseline for this work had 145 full-catalog tools. A historical live production observation recorded in [`mcp-optimization-verification.md`](./mcp-optimization-verification.md) reported 134 tools on 2026-09-13, so the saved live observation and later source inventory were already misaligned before this change. This is historical evidence only: Task 6 made no live MCP request and does not establish what a deployed endpoint serves now. The current branch adds `tool.catalog.search` and `loan.schedule.defer`, producing 147 tools and the new eight-tool discovery profile; the plugin snapshots are generated from this branch. Current live alignment remains unverified and deployment-pending.

After a separately authorized rollout, compare the server-advertised catalog version and profile counts with the generated plugin contract/index, refresh or reconnect the intended MCP profile, check catalog/workflow/guidance versions, and begin a new task so the client reads the refreshed contract. Reconnect to the required domain profile to call capabilities hidden from `/mcp/discovery`; metadata search cannot dynamically load them. Host/client acceptance and model tool-selection accuracy remain unverified.
