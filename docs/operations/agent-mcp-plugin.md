# CreditSync Agent, Remote MCP, and Private Plugin Operations

This guide covers the private owner-operated deployment. It does not configure public OAuth, public plugin submission, multi-tenant agent administration, server-side OCR, or MCP funding mutations.

## Architecture

The Elysia backend serves REST and stateless Streamable HTTP MCP in one process. `/mcp` constructs a server/transport per request and calls the same application services as REST; it never loops back through REST. Nginx proxies `/mcp` without buffering and Cloudflare Tunnel exposes the frontend host over HTTPS. PostgreSQL is the accounting source of truth, MinIO stores optional evidence, and Dragonfly supplies distributed rate limiting with an in-process safety fallback.

## Deployment checklist

1. Back up PostgreSQL and MinIO using `backup-recovery.md`.
2. Configure `.env.production` from `.env.example`. Required MCP settings are `MCP_API_TOKEN_HASHES`, `MCP_ALLOWED_HOSTS`, `MCP_TENANT_ID`, `MCP_ACTOR_EMAIL`, `MCP_RATE_LIMIT_MAX`, and `MCP_RATE_LIMIT_WINDOW_SECONDS`.
3. Ensure the fixed MCP actor already exists in the fixed tenant. A client cannot choose either identity.
4. Start infrastructure, then the application:

```bash
docker compose --env-file .env.production -f docker-compose.infra.yml up -d
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d
```

5. Route the Cloudflare public hostname to `http://frontend:80` on `creditsync_runtime`. Set `MCP_ALLOWED_HOSTS` to that external hostname without scheme or path.
6. Verify `GET https://<host>/mcp/health` exposes status/schema only. Verify invalid bearer credentials fail, a legacy v1 client can initialize/list the frozen 134-tool `/mcp` catalog, and a modern client can discover/list the paginated catalog.
7. Review backend logs for request/correlation/tool/status/duration only. Raw authorization, tool payloads, QR values, slip contents, identity fields, and signed URLs must not appear.

## MCP eras, profiles, and discovery

`/mcp` remains the compatibility route: legacy v1 requests retain the full unpaginated `tools/list` response and their legacy envelope. The modern 2026-07-28 route uses the official v2 envelope, per-request protocol/client metadata, deterministic 25-tool pages, opaque cursors bound to profile and catalog version, and `ttlMs: 300000` with `cacheScope: "public"` for definition discovery only. Empty-string cursors are not treated as falsey; malformed, stale, out-of-bounds, or cross-profile cursors are invalid parameters.

Curated routes are `/mcp/core-read`, `/mcp/payments`, `/mcp/loans`, `/mcp/disbursements`, and `/mcp/admin`. They reduce discovery context but are not bearer authorization scopes; the same tenant, actor, Origin, Host, authentication, and rate-limit protections apply. The generated catalog and profile snapshots under `plugins/creditsync/references/` are the source of tool counts.

Browser access must allow `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` in addition to the existing authorization/request headers. Configure `MCP_ALLOWED_ORIGINS` as exact origins only; wildcard, `null`, malformed, and unexpected origins are rejected before request-body parsing. See [`mcp-conformance-baseline.yml`](./mcp-conformance-baseline.yml), [`mcp-canary-runbook.md`](./mcp-canary-runbook.md), and [`mcp-optimization-verification.md`](./mcp-optimization-verification.md) for pinned verification and rollout evidence.

## Bearer token creation and rotation

Generate the raw value on the client/operator machine. Store it only in the Codex private app secret. Put only its lowercase SHA-256 digest on the server:

```bash
umask 077
CREDITSYNC_MCP_TOKEN_FILE=/secure/operator/location/creditsync-mcp-token
openssl rand -hex 32 | tr -d '\n' > "$CREDITSYNC_MCP_TOKEN_FILE"
chmod 600 "$CREDITSYNC_MCP_TOKEN_FILE"
test "$(wc -c < "$CREDITSYNC_MCP_TOKEN_FILE")" -eq 64
sha256sum "$CREDITSYNC_MCP_TOKEN_FILE"
```

The `tr` plus 64-byte assertion ensures the server hashes exactly the raw token bytes and not a trailing line feed. Put the displayed digest on the server; load the raw file into the private app secret without adding a newline.

For rotation, configure old and new digests as the two comma-separated `MCP_API_TOKEN_HASHES`, redeploy the backend, update the private app secret, verify the new token, remove the old digest, and redeploy. The server accepts at most two unique hashes. Never print the raw token in CI output or commit a digest/environment file.

## Optional MinIO payment evidence

Evidence is not required to create or post a payment intake. For image-first capture, Codex extracts structured fields and QR data locally, creates the intake, computes file SHA-256, obtains a short-lived signed PUT with `evidence.prepare`, uploads unchanged bytes using its required headers, and calls `evidence.finalize`. CreditSync verifies stored metadata before linking evidence. It does not invoke OCR/AI and never accepts a caller-provided fetch URL.

Keep `STORAGE_PROVIDER=s3`, `S3_ENDPOINT` reachable by the backend, and `S3_PUBLIC_URL` reachable by the uploading client through `/files` where applicable. Limit `EVIDENCE_UPLOAD_TTL_SECONDS` and `EVIDENCE_MAX_BYTES`; do not log raw QR payloads or signed URLs.

## Evidence requirement enforcement matrix

An attachment declaration or accepted prepare/import for a mutable payment intake or loan-disbursement event creates a sticky requirement before storage or signing work. Requirements are tenant-scoped, typed, append-only in intent, and can only increase while the parent is mutable. A pending or rejected required intent blocks the authoritative preview/post/activation check; a resolver response never substitutes for this check.

| Entry point | Actual consumed target | Guard location | Supported transport | Terminal replay | Scoped regression |
| --- | --- | --- | --- | --- | --- |
| `intake.get`, `intake.list` | tenant-scoped payment-intake rows | access and tenant filters; read-only | MCP read | n/a | payment service reads |
| `intake.create` | new mutable payment intake | command context/idempotency; evidence is checked by later payment kernels | no attachment required; existing intake/evidence workflow | create idempotency returns the existing intake | payment service tests |
| `evidence.prepare`, `evidence.finalize` | payment intake evidence intent/file | mutable-intake lock, sticky requirement registration, exact file/finalization checks | direct signed PUT/finalize | ready evidence returns its original receipt | payment evidence tests |
| `evidence.import-chatgpt-file` | payment intake evidence intent/file | importer identity/download checks, then payment evidence finalization | supported ChatGPT import only | import identity returns the original receipt | primary-owned importer tests |
| `payment.evidence-supplement.import-chatgpt-file`, `payment.evidence-supplement.record` | payment intake supplement and its immutable audit | supplement service target/state/audit checks; no generic payment alias | supported ChatGPT supplement import or recorded reviewed supplement | supplement idempotency returns its original receipt | payment evidence tests |
| `payment.preview` | payment intake and explicit loan/schedule allocations | payment matching kernel evidence assertion before proposal writes | existing intake evidence workflow | preview artifacts are versioned, not terminal receipts | payment service tests |
| `payment.post` | payment intake, match proposal, transactions and rollups | payment posting kernel rechecks intake evidence before financial writes | existing intake evidence workflow | posted payment returns the original receipt before mutable checks | payment service tests |
| `payment.cancel` | unposted payment intake | state-hash, chronology, evidence-retention and idempotency checks | no new evidence transport | cancellation receipt is replayed by idempotency key | cancellation tests |
| `payment.reverse`, `payment.reverse-with-accrual.preview`, `payment.reverse-with-accrual.execute` | posted payment intake and compensating transactions/accruals | posted-record provenance, preview hash and reversal idempotency checks; no new attachment target | existing posted-payment reversal workflow | existing reversal receipt is returned before new writes | payment reversal tests |
| `payment.batch.create`, `payment.batch.capture`, `payment.batch.item.add`, `payment.batch.stage`, `payment.batch.staging.extract`, `payment.batch.staging.review`, `payment.batch.staging.edit`, `payment.batch.split`, `payment.batch.decision`, `payment.batch.cancel` | batch/staging rows and linked mutable payment intakes | batch state, member ownership and chronology checks; evidence declarations remain sticky | existing intake/staging transports | batch/staging idempotency returns the existing operation | batch service tests |
| `payment.batch.evidence.prepare-many`, `payment.batch.evidence.finalize-many`, `payment.batch.evidence.prepare`, `payment.batch.evidence.finalize`, `payment.batch.staging.evidence.prepare`, `payment.batch.staging.evidence.finalize` | each named batch member or staging intake evidence intent/file | member-scoped mutable lock and exact evidence validation | existing direct signed PUT/finalize only | ready intents return their original evidence receipts | batch evidence tests |
| `payment.batch.get`, `payment.batch.workspace`, `payment.batch.candidates` | tenant-scoped batch/staging/candidate projections | access and immutable snapshot filters; read-only | MCP read | n/a | batch read tests |
| `payment.batch.preview` | every selected batch payment intake | all-member evidence readiness and exact allocation snapshot before preview | existing batch staging workflow | preview is versioned; execute replay is separate | batch tests |
| `payment.batch.execute` | every selected intake, transactions, fund effects and batch status | locked batch/member recheck before any item write; all-or-nothing | existing batch staging workflow | committed batch receipt is replayed before rechecking members | `payment-batch-atomic.integration.test.ts` |
| `payment.reconcile.preview`, `payment.reconcile.preflight`, `payment.reconcile.mark-review` | payment intake and selected source/target transactions | reconciliation snapshot, chronology and payment evidence checks | existing payment-intake workflow | preview/review artifacts are not terminal money receipts | reconciliation tests |
| `payment.reconcile.execute`, `payment.restore.execute` | consumed source intake, exact restore intake, replacement transactions/groups | locked consumed-intake and source evidence checks before audit/group/financial writes | existing restore/evidence prepare/finalize only | committed reconciliation receipt is returned before mutable guards | `payment-reconciliation-service.test.ts` |
| `payment.restore.preview` | source payment intake and exact restore draft | source evidence and restore-draft expected-count checks before ready preview | existing restore evidence workflow | preview is versioned; execute replay is separate | `payment-reconciliation-service.test.ts` |
| `payment.restore.create`, `payment.restore.schedule-backfill` | immutable source intake, restore draft or exact schedule | source lineage, schedule state and idempotency checks; no inferred target | existing restore workflow only | existing restore/backfill receipt is replayed | restore tests |
| `payment.restore.evidence.prepare`, `payment.restore.evidence.finalize` | exact restore-draft evidence intent/file | restore-draft mutable lock and exact file/finalization checks | direct signed PUT/finalize only | ready intent returns its original receipt | restore evidence tests |
| `payment.reconcile.reflow.preview`, `payment.reconcile.reflow.execute` | reconciliation intake and every source transaction's payment intake | consumed-intake and temporal-source evidence checks after locks, before reflow proposal/group/reversal writes | existing payment-intake evidence only; no floating transport | committed reflow receipt is replayed before mutable checks | `payment-reconciliation-reflow-service.test.ts` |
| `payment.allocation-correction.preview`, `payment.allocation-correction.execute` | consumed payment intake, source transaction and target schedule | locked correction context and consumed-intake evidence check before correction writes | existing payment-intake evidence only | correction-group replay precedes the guard | `payment-allocation-correction-service.test.ts` |
| `loan.preview`, `loan.draft`, `loan.draft.delete` | loan draft/terms and draft deletion state | draft validation, ownership, dependency and idempotency checks; no attachment inferred | no implicit attachment transport | deletion/creation idempotency returns the original result | loan application tests |
| `loan.activate` | known draft payout events for the loan, then loan terms/schedules/funding | borrower→loan locks, payout evidence assertion, then activation effects | no implicit attachment transport; use payout workflow | stored activation result is returned before mutable guard | `loan-application-service.test.ts` |
| `loan.payment-start-date.update` | unpaid loan schedules and loan next-due state | immutable posted-payment boundary, exact date and audit checks | no evidence target | idempotent state update returns its original audit result | loan application tests |
| `loan.interest-rate.list`, `loan.interest-rate.preview`, `loan.interest-rate.execute` | loan interest-rate timeline | access, date overlap, version and stale-preview checks; no attachment target | no evidence transport | committed rate-change receipt is replayed | interest-rate tests |
| `loan.settlement.preview`, `loan.settlement.execute`, `loan.settlement.reverse` | source floating loan, close-account transaction and compensations | source-loan payout evidence assertion after locks and replay branch; reversal uses downstream provenance | no new settlement attachment transport | committed settlement/reversal receipt is replayed before mutable guard | `loan-settlement-service.test.ts` |
| `loan.cancel.preview`, `loan.cancel.execute` | unfunded draft loan and cancellation audit | unfunded/dependency, exact preview and idempotency checks; no attachment target | no evidence transport | committed cancellation receipt is replayed | loan cancellation tests |
| `loan.replacement.preview`, `loan.replacement.execute`, `loan.replacement.reverse` | old loan, replacement draft, schedules, funding and corrections | replacement graph/funding locks; execute delegates replacement activation payout guard | existing payout evidence workflow only; no replacement transport | committed replacement receipt is replayed before mutable checks | `loan-replacement-service.test.ts` |
| `loan.contract.get`, `loan.inspect-context`, `loan.payment-history.list` | tenant-scoped authoritative loan/contract/payment-history projections | access and target lineage filters; read-only | MCP read | n/a | loan read tests |
| `loan.disbursement.list`, `loan.disbursement.draft`, `loan.disbursement.update` | loan-disbursement event and its parent loan | parent/event lock, mutable draft checks and strict field validation | no attachment on draft; existing payout evidence workflow follows | draft/update idempotency returns existing event | disbursement tests |
| `loan.disbursement.evidence.prepare`, `loan.disbursement.evidence.finalize` | exact payout event evidence intent/file | loan→event→evidence lock order, sticky requirement and exact storage metadata | direct signed PUT/finalize only | ready evidence returns its original receipt | disbursement evidence tests |
| `loan.disbursement.evidence.import-chatgpt-file` | exact payout event evidence intent/file | importer identity/download checks, then payout evidence finalization | supported ChatGPT import only | import identity returns the original receipt | primary-owned importer tests |
| `loan.disbursement.post`, `loan.disbursement.reverse` | payout event and immutable reversal/provenance | payout post rechecks event/parent evidence; reversal requires posted event and explicit reason | existing payout evidence for post; no new reversal transport | posted/reversed receipt is returned before mutable checks | disbursement tests |
| `loan.commission-participant.list`, `loan.commission.preview`, `loan.commission.list`, `loan.commission.calculate`, `loan.commission.reverse` | commission participant/payment-derived projections | access and posted-payment provenance; commission reverse is read-only | MCP read | n/a for projections | commission tests |
| `loan.commission-participant.add`, `loan.commission-participant.update`, `loan.commission-participant.end` | effective-dated immutable commission participant versions | effective-date overlap, append-only successor and idempotency checks; no attachment target | no evidence transport | existing participant receipt is replayed | commission participant tests |
| `payment.match-context` | payment matching context and candidate contracts | access and authoritative snapshot filters; read-only | MCP read | n/a | payment context tests |
| `payment.intermediary-attribution.create`, `payment.intermediary-attribution.list`, `payment.intermediary-attribution.reverse` | payment/transaction intermediary attribution and compensating reversal | linked payment/transaction ownership, exact amount and reversal provenance | no new evidence transport; linked payment must pass its own kernel | attribution idempotency/reversal receipt | attribution tests |
| `intermediary.search`, `intermediary.create`, `intermediary.profile.get`, `intermediary.bank-account.save`, `intermediary.managed-loan.list`, `intermediary.assignment.create`, `intermediary.assignment.end` | intermediary/profile/account/assignment records | tenant access, role, effective-date and append-only checks; no money consumed | MCP/REST profile workflows | record idempotency where supported | intermediary profile tests |
| `intermediary.disbursement.list`, `intermediary.disbursement.get`, `intermediary.disbursement.create` | intermediary payout group and its contractual target | group/loan/intermediary ownership and immutable target snapshot | no new attachment transport | group idempotency returns existing group | intermediated-disbursement tests |
| `intermediary.disbursement.event.create` | exact funding, borrower-payout or advance-return transfer event | group lock, role/amount validation and immutable event provenance | no new attachment transport | event idempotency returns existing event | intermediated-disbursement tests |
| `intermediary.disbursement.evidence.prepare`, `intermediary.disbursement.evidence.finalize` | exact transfer event evidence intent/file | group→event→evidence lock order and exact storage metadata | existing direct signed PUT/finalize only | ready transfer evidence returns its original receipt | transfer evidence tests |
| `intermediary.disbursement.preview` | group totals, role-level transfers and transfer evidence | exact role totals and evidence readiness; unsupported/missing association is `needs_review` | no new intermediary transport | preview is versioned; post replay is separate | `intermediated-disbursement-service.test.ts` |
| `intermediary.disbursement.post`, `intermediary.disbursement.reverse` | transfer group, linked payout events, loans and compensating reversals | exact ready preview, each transfer evidence target and downstream provenance | existing transfer evidence workflow only | committed group receipt is replayed before mutable checks | intermediated-disbursement tests |
| `intermediary.collection.list`, `intermediary.collection.create` | collection record and optional linked payment intake | borrower/loan/intermediary lineage; linked payment is rechecked by payment kernel at remittance post | no new collection transport | collection idempotency returns existing record | intermediary service tests |
| `intermediary.remittance.get`, `intermediary.remittance.create`, `intermediary.remittance.allocations.save` | remittance and selected collection allocation records | ownership, chronological selection, exact amount and mutable-state checks | no new evidence target | remittance/allocation idempotency returns existing record | intermediary service tests |
| `intermediary.remittance.preview` | remittance, selected collections and linked payment targets | exact allocation preview; linked payment readiness is enforced at post | no new remittance transport | preview is versioned; post replay is separate | intermediary service tests |
| `intermediary.remittance.evidence.prepare`, `intermediary.remittance.evidence.finalize` | remittance evidence intent/file | remittance lock and exact storage metadata | existing direct signed PUT/finalize only | ready evidence returns its original receipt | intermediary evidence tests |
| `intermediary.remittance.post` | remittance, collections and either linked or newly created payment intakes/transactions | collection locks; linked intake delegates to payment preview/post kernel before financial writes | existing payment-intake evidence for new/unfinalized linked payment | committed remittance receipt is replayed before mutable checks | intermediary linked-payment regression |
| `renewal.preview`, `renewal.execute`, `renewal.reverse` | old loan, replacement loan/schedule, charges and payout/collection | source-loan payout evidence assertion after locks and replay branch; no renewal attachment transport | existing payout workflow only; unsupported association is human-review-only | committed renewal/reversal receipt is replayed before mutable guard | `loan-renewal-service.test.ts` |
| `loan.restructure.preview`, `loan.restructure.execute`, `loan.restructure.reverse` | source loan, replacement loan/schedule, opening components and additional payout draft | source-loan payout evidence assertion after locks and before replacement effects; execute replay first | existing payout workflow only; unsupported association is human-review-only | committed restructure/reversal receipt is replayed before mutable guard | `loan-restructure-service.test.ts` |
| `loan.waiver.preview`, `loan.waiver.execute`, `loan.waiver.reverse` | interest/fee/penalty waiver preview and append-only compensation | component eligibility, reason, preview hash and downstream provenance; no payout evidence target | no waiver attachment transport | committed waiver/reversal receipt is replayed | waiver tests |
| `funding-source.list`, `funding-allocation.preview`, `funding-allocation.list` | funding source/allocation projections | access and source-capacity snapshot; read-only/preview | MCP read | n/a for reads | funding tests |
| `funding-allocation.create` | append-only loan funding allocation | source capacity, active loan, exact money and idempotency checks; no attachment target | no evidence transport | allocation receipt is replayed | funding tests |

Every name above is an actual catalog key; no row is a generic “intermediary paths” placeholder. Where a flow has no supported way to associate evidence with the consumed target, it remains a human-review-only `needs_review`/stop case; no caller-provided URL, inferred borrower, or synthetic payment intake is accepted.

Floating settlement/renewal and intermediary attachment-bearing paths without a supported pre-execution evidence association are human-review-only. Do not create a fake payment intake, infer a target from a name/amount, or invent a generic payment workflow. The backend cannot detect a file that the host never reports. Historical pending-recovery warnings remain warnings and never grant financial permission. Real mobile file transport, host catalog adoption, production migration and rollout checks remain operator-pending.

## Private app and plugin installation

1. Register `https://<host>/mcp` as a private Codex app using bearer authentication.
2. Replace the conspicuous ID in `plugins/creditsync/.app.json` with the returned technical ID beginning `plugin_asdk_app`.
3. Validate:

```bash
bun test plugins/creditsync/tests
bun run plugins/creditsync/scripts/validate.ts
python3 /home/flintstone/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/creditsync
```

4. Add the repository marketplace and install:

```bash
codex plugin marketplace add /absolute/path/to/CreditSync
codex plugin add creditsync@personal
```

5. Start a new Codex task. Test borrower search first, then a disposable data-only intake before any production financial flow.

The committed placeholder cannot connect and must remain until private registration supplies a real ID. URL and secrets never belong in the plugin package.

## Single-payment settlement and restructure operation

Use the same inspect-first sequence in Web, REST, or the CreditSync Plugin:

1. Resolve the borrower and inspect the exact source loan. Never turn a fuzzy alias candidate into a financial selection automatically.
2. Preview the settlement/restructure. Single-payment contract interest is either the fixed agreed amount or the greater of fixed and retroactive actual-disbursement exposure; the candidates are mutually exclusive. A contracted daily late penalty may accrue concurrently after its due date and grace period.
3. Review principal, interest, fee, and penalty separately. A waiver forgives an eligible non-principal component and requires a reason. An external payment is real settlement value and must include its payer/source identity; it allocates through the normal component order and must not leave an unexplained remainder.
4. Review the independently priced replacement type and exact schedule. Only outstanding principal plus optional additional approved principal forms replacement principal. Carried interest/fees/penalties remain separate opening components. Any additional-principal cash-out is a linked disbursement draft, not a posted payout.
5. Obtain explicit human confirmation of the displayed preview, cash direction, waiver reasons, external-payment identity/allocation, replacement terms, and any new payout. Execute using the returned preview public ID/hash, expected balance version, reason, and a stable operation-scoped idempotency key. Stop on expiry, staleness, ambiguity, conflict, or changed cash.
6. Re-read the old/replacement loans, restructure record, opening components, waivers, and linked disbursement draft. Post an actual payout only through the existing disbursement inspect/evidence/confirm/idempotency workflow.

Later waivers follow their own preview, exact confirmation, execute, and compensating-reversal flow. Only interest, fee, and penalty are eligible; principal is never waivable. Before restructure or waiver reversal, re-list the exact record, state the reason, and obtain confirmation. Stop when downstream payments, posted disbursements, later waivers/restructures/renewals, or another dependency blocks safe compensation. Never edit or delete an executed aggregate, opening component, waiver, allocation, or posted financial row.

## v0.3.12 migration and release verification

Deploy the complete ordered migration chain through `0035_disbursement_restructure_relation.sql`. In the contiguous release range, `0023`–`0026` establish intermediary collection/remittance, effective-dated floating rates, append-only accrual correction, and evidence dependencies; `0027` starts the settlement/restructure schema; `0028`–`0030` complete floating weekly snapshots and the append-only penalty ledger used by settlement projections; and `0031`–`0035` add durable waiver preview/scope/provenance, external-credit allocation, and payout lineage. Do not skip intermediate migrations or apply selected files manually.

Before deployment, with production writers stopped or routed away:

1. Back up PostgreSQL and MinIO and retain the previously deployed application images/plugin snapshot.
2. Validate a fresh disposable PostgreSQL migration chain and all database-backed suites with `cd backend && ./scripts/test-disposable-postgres.sh`, then run `bun run typecheck`.
3. Run `cd frontend && bun run test && bun run lint && bun run build` and, from the repository root, `bun test plugins/creditsync/tests`, `bun plugins/creditsync/scripts/validate.ts`, and the plugin-creator validator.
4. Start infrastructure first, then rebuild backend and frontend. Confirm backend logs report migrations through `0035` without errors.
5. In the production PostgreSQL container, inspect `__drizzle_migrations` and the expected loan/restructure/waiver/opening-component/external-credit/disbursement-relation columns and tables. This is a schema-only check—do not create test loans or transactions in a live tenant.
6. Check internal backend MCP health at `http://127.0.0.1:3000/mcp/health` from the backend container, public frontend health at `http://127.0.0.1:8088/`, authenticated `tools/list` count/contract, and sanitized logs.
7. Reconcile loans, schedules, transactions, funding, disbursements, restructures, opening components, waivers, and external-credit allocations before reopening Web/MCP writes.

Applied additive migrations remain in place during an application rollback. Roll back only to an image compatible with those columns/tables; never down-migrate by deleting financial history.

## Release and operational rollback

Before rollout, preserve database/object backups and the previously deployed app image/plugin directory. Apply migrations before accepting writes, then run reconciliation totals and the MCP contract suite. If application health or accounting verification fails:

1. Disable Cloudflare `/mcp` ingress while leaving web/REST routes available. As a second kill switch, replace `MCP_API_TOKEN_HASHES` with the SHA-256 of one newly generated, valid token whose raw value is not distributed to any client. **Never leave `MCP_API_TOKEN_HASHES` empty**: empty/invalid configuration intentionally prevents the shared backend from starting and would also take REST offline.
2. Keep the database and object store intact; do not delete or edit posted records.
3. Roll the application image back only when it remains compatible with applied additive migrations.
4. If data restoration is required, stop all writers and follow the isolated restore procedure in `backup-recovery.md`.
5. Reconcile transaction, schedule, loan, renewal, restructure, waiver, disbursement, opening-component, external-credit, and funding totals before reopening web/MCP writes.

Removing or reinstalling the plugin affects only Codex discovery. It does not roll back financial data.
