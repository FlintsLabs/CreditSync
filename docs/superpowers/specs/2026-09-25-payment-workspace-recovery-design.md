# Payment workspace and recoverable posting design

Date: 2026-09-25
Status: Written specification for review. The user approved the conceptual design in the task; implementation and production changes are not part of this document change.
Source baseline: `250f523`.

## 1. ข้อตกลงกับผู้ใช้

ผู้ใช้ต้องนำเข้าสลิปย้อนหลัง แก้วัน ยอด ผู้กู้ สัญญา และภาพหลักฐาน จัดการรายการซ้ำ ย้ายสลิปเข้าออกชุด และกลับมาทำต่อได้ โดยไม่ต้องจัดการ staging/intake/recovery/replacement/reconciliation เองหลายรอบ

หน้าที่ของระบบคือรับข้อมูลไว้ก่อน ตรวจปัญหาทั้งหมด เตรียมแผนลงบัญชีหรือแก้บัญชีที่แสดงผลกระทบครบ แล้วให้ผู้ใช้ยืนยันแผนนั้น ส่วนข้อมูลที่ยังไม่พอต้องระบุว่าขาดอะไรและทำอะไรต่อได้ ไม่ล็อกงานที่ไม่เกี่ยวข้อง

สิ่งที่ต้องเปลี่ยน:

- แยก “เอาออกจากชุด”, “พักไว้”, “ยกเลิก” และ “แก้รายการที่โพสต์แล้ว” ให้ชัด
- ไม่ต้อง cancel เพื่อแก้ข้อมูลร่างหรือเปลี่ยนภาพ
- ไม่เพิ่มจำนวนหลักฐานที่ต้องส่งตามจำนวน upload retries
- สลิปข้ามวันต้องตรวจผลกระทบทางบัญชี ไม่ห้ามเพียงเพราะลำดับนำเข้าไม่ตรงวันโอน
- การกู้คืนต้องพากลับไปสู่รายการที่ทำงานต่อได้ครบ รวมหลักฐาน สมาชิกชุด และ identity
- การรับชำระผ่านคนกลางต้องแยกจากการนำส่งเงินให้ผู้ให้กู้
- ไม่ลบประวัติ ไม่ลงเงินซ้ำ และไม่ถือล็อกรอผู้ใช้หรือรอ upload/OCR

คำว่า “แก้ได้” หมายถึงมีคำสั่งแก้ไขหรือคำถามที่เฉพาะเจาะจงสำหรับทุกสถานการณ์ในขอบเขต ไม่หมายถึงสามารถแต่งหลักฐาน ข้ามสิทธิ์ หรือแก้ posted rows โดยตรง และไม่รับประกันว่า database จะไม่เกิด transient deadlock เลย

## 2. Existing capabilities and confirmed gaps

Reuse, rather than duplicate, the existing services:

| Existing component | Responsibility retained | Integration needed |
| --- | --- | --- |
| `payment-identity-decision-service.ts` | Explicit same/distinct decisions, transitive groups, single active financial effect | Workspace resolution and shared dependency snapshot |
| `payment-evidence-recovery-service.ts` | Confirmed recovery child, inherited evidence requirement, immutable source | Resume the child and connect it to the intended workspace item |
| `payment-effective-evidence-service.ts` | Direct/referenced/recorded supplemental evidence | Explicit evidence slots and supersession coverage |
| `payment-batch-service.ts` | Existing batch posting and staging | Reusable item resolution, mutable selection, actionable completeness checks |
| `payment-allocation-correction-service.ts` | Posted scheduled allocation correction | Integrated impact preview |
| Reconciliation/reflow services | Compensating historical allocation changes | Complete dependency planning, resumable status |
| `payment-workflow-locks.ts` | Transaction-local lock timeout and bounded retry | Consistent adoption and short critical sections |
| `payment-workflow-blockers.ts` | Typed blocker classification | State-valid actions and cycle detection |

Static evidence at the baseline:

- Staging review inserts an intake directly; its public input has no operation for binding a recovered intake. Merely adding a batch member does not validate the unresolved staging row. See `reviewPaymentBatchStagingItem`, `addPaymentBatchItem`, and `assertBatchStagingComplete`.
- `assertNoOlderPendingPayment` looks for older pending work at borrower scope; an unfinished unrelated item can force a chronology conflict before a useful combined resolution is available.
- Evidence coverage readers incorporate upload attempt counts into historical requirement floors. Failed attempts cannot simply be discarded; new slot semantics need an explicit legacy compatibility decision.
- `finalizePaymentBatchStagingEvidence` performs storage HEAD while inside a transaction with locked staging/batch state.
- The existing tenant-first lock helper sets a 2-second lock timeout. The transaction wrapper retries PostgreSQL `40P01`/`40001` at most three times; this does not by itself provide a bounded end-to-end user operation or a complete workflow recovery route.
- Intermediary attachments are intentionally routed to human review by the workflow registry. A payment upload transport must not be treated as proof of intermediary remittance.

These are code observations, not a reproduced production deadlock or proof that every production instance runs this revision.

## 3. Options and chosen boundary

1. Remove guards and locks: rejected. Concurrent or duplicate postings would become possible, and historical accounting correctness would depend on agent behavior.
2. Continue adding isolated recovery buttons: insufficient. It preserves the current requirement for users to coordinate internal lifecycle steps.
3. Add a shared workspace resolution and execution layer over the existing financial services: selected. Keep correctness constraints, but make dependency handling and recovery one product flow.

This is a targeted orchestration layer, not a replacement accounting engine or generic workflow platform. Financial calculations remain in backend services using decimal.js and two-decimal public strings.

## 4. Domain model and authority

### Workspace item and transfer identity

A stable workspace item represents supplied payment information and references evidence, reviewed facts, identity decisions, and its current intake or recovery successor. Creating an item is not a financial posting.

- Multiple images can describe one transfer; a grouped transfer may allocate to several contracts.
- Image hashes detect identical files, not all semantic duplicates. Similar names, equal amounts, or nearby timestamps only identify candidates.
- Strong reference conflicts require review. Cancelling an intake does not erase its bank-reference identity or make that identity freely reusable.
- Confirmed identity and lineage use the existing services. At most one active financial effect may consume a confirmed transfer identity, excluding its own compensating history.
- Mutable facts have a revision and append-only audit history. Changing amount/time/payer invalidates affected identity decisions and previews, not unrelated items.

### Workspace versus posting batch

The workspace is a durable inbox. A posting batch is a versioned selection of items and allocations for a particular execution.

- Removing an unposted item from a selection returns it to the inbox, preserving evidence and reviewed facts.
- Pausing an item records a reason and unresolved obligations; it neither marks the transfer posted nor cancels it.
- Cancellation is explicit abandonment of a draft financial intent. A cancelled item has a resume action that follows an existing successor or creates a receipt-backed recovery successor.
- Historical batch membership remains auditable. Add a membership/resolution projection or append-only events for new selection semantics; do not rewrite historical posted/cancelled batch rows or drop uniqueness constraints to move them.
- Legacy batch cancellation remains available with its existing whole-batch semantics. New UI must disclose its exact members and must not use it as the default action for removing one slip.

### Product status projection

| Product status | Meaning | Available progress |
| --- | --- | --- |
| Needs information | Facts, evidence, identity, or routing unresolved | Edit, upload/retry, resolve, pause, remove from selection |
| Ready to review | Selected items have a complete impact plan | Inspect preview and confirm |
| Processing | Accepted operation has a durable identity | Inspect receipt/status; retry the same command safely |
| Recorded | Financial or collection result exists | View receipt; prepare correction/supplement |
| Paused | Work intentionally deferred | Resume and recompute plan |
| Cancelled | Draft financial intent abandoned | View history; resume through a linked successor |

This projection does not replace the backend's precise accounting statuses. It must distinguish borrower payment, intermediary collection, remittance, and ledger posting.

## 5. Editing and evidence lifecycle

Use requirement slots separately from upload attempts. Each slot records its purpose, required/optional status, and selected verified evidence version. Each upload attempt records MIME, size, checksum, expiry, failure and storage metadata independently.

- Retry of the same attempt/command resumes its receipt. A new attempt for the same slot does not increase required slot count.
- A new verified image can supersede the selected image in a mutable slot. The previous image and selection event remain auditable.
- Detaching required evidence makes that item incomplete; it does not silently waive the requirement.
- Posted records use existing supplement/correction semantics. Original evidence and posted financial rows remain immutable.
- Do not attach raw file IDs. Referenced reuse must check tenant/owner access, exact ready evidence, identity compatibility, and its audited coverage authorization.
- For legacy rows, preserve the existing requirement floor until an explicit recovery/requirement decision maps failed attempts to slots. Do not migrate all failed attempts into an automatic waiver.

Signed upload, OCR and storage HEAD happen outside financial critical sections. Finalization verifies storage against an immutable object version/checksum and rechecks target revision/access in a short transaction. Expired authorization or changed object state returns a resumable item-level action.

## 6. One resolution and preview surface

Introduce shared application services behind both REST and closed-schema MCP tools. The implementation plan will assign final names; their required behavior is fixed here:

1. Inspect workspace: read-only current items, canonical/successor references, versions and evidence slots.
2. Edit selection/facts/evidence decisions: audited, revision-checked commands; no money movement.
3. Prepare plan: calculate all item dispositions, identity/recovery requirements, allocations and downstream effects. It may persist an auditable plan snapshot but must not create financial effects, cancel records, execute identity decisions, or mutate facts as a side effect.
4. Execute confirmed plan: revalidate exact scope, dependencies and authority, then apply the confirmed operations idempotently.
5. Get operation: report an existing command's committed result or known failure without repeating its effects.

A plan contains selected/excluded item IDs, input revisions, evidence versions, exact decisions and reasons, affected contracts/obligations, before/after money components, ordered compensating actions, dependency groups, warnings, unresolved questions, expiry, and a confirmation hash. Public data must be safe UUIDs and decimal strings.

Preview works on incomplete items: it returns useful information and actions instead of throwing at the first business blocker. Incomplete items cannot be executed. Querying or regenerating an identical preview must not invalidate its own inputs.

Existing hard guards remain authoritative at execution. Informational notices are shown separately from unresolved warnings; only a ready plan with complete evidence/allocations, zero variance and no unresolved warnings can post. A reviewed decision resolves a warning through audited state, not by hiding it in the frontend.

Preparatory human decisions can be confirmed together with the financial plan when the exact decisions and resulting financial effects are computable in advance. Uploads or missing facts that prevent calculation must be completed first. A newly discovered financial effect cannot be silently included under an earlier confirmation.

Business-relevant changes invalidate confirmation and display a focused before/after diff. Note-only changes outside the dependency snapshot do not. Refreshing due to concurrent changes preserves user selections and never restarts ingestion.

## 7. Backdated payments and dependency planning

Keep transfer timestamp, Bangkok business date, target obligation date and system recording time distinct. Never change the transfer date to bypass a guard. Unknown times stay unknown until reviewed; future timestamps are corrected or explicitly handled under a supported policy, not fabricated.

### Scheduled loans

When an exact installment can accept the payment without changing an existing allocation, allow a direct historical allocation plan. Verify penalties, installment mode, prior waivers, settlement and current outstanding amounts. An amount above the agreed installment routes to an explicit settlement/unallocated/other supported disposition, never an implicit ordinary overpayment.

### Floating loans

Use authoritative backend accrual and allocation services. If the historical receipt affects later allocations, calculate the affected interval and create one compensating reflow/reconciliation plan. Preserve principal, rate changes, advance-interest policy, already reversed accruals, and current provenance constraints. Never recreate interest math in the agent or UI.

### Pending and downstream work

- An unclassified attachment or an unrelated contract's draft does not automatically block all posting for a borrower.
- A pending item with a proven shared obligation/dependency is included in the impact graph. Offer inclusion, explicit deferral with its future reconciliation consequences where supported, or a concrete question.
- Deferral is not a claim that no older payment exists and cannot authorize a false `confirm_no_older_pending` decision.
- Renewal, settlement, waiver, payout, commission or remittance dependencies must be discovered before confirmation. Include supported compensating operations in dependency order. Do not imply that one generic reflow safely reverses every lifecycle event.
- If a dependency needs missing evidence, external repayment, a separate authorized lifecycle decision, or an unsupported adapter, return that exact action and retain the workspace. Do not auto-reverse such a dependency.
- Known in-scope lifecycle combinations require implemented adapters or a specifically tested assisted correction route before release; an unspecified “human investigation” fallback is not a passing result.

Split selected items into independent financial dependency groups. Each group commits atomically. The user explicitly chooses all-or-nothing for a supported bounded selection or “process ready groups”; never silently post a subset of a batch approved as a whole. No single dependency group may be split to fit a transaction timeout.

## 8. Recovery, duplicate resolution and batch repair

The resolution layer must support the following without manual SQL:

- Continue an existing recovery successor before creating another.
- Create a successor for an incomplete cancelled draft through the existing evidence-recovery preview/execute path.
- Complete missing evidence on the child and preserve coverage receipts for historical incomplete participants.
- Resolve an existing draft duplicate using exact same/distinct decisions. Do not infer identity from OCR, amount or time similarity alone.
- Bind the selected canonical/recovered intake to the unresolved workspace/staging item, its ready evidence, and the selected execution membership atomically. Reject incompatible amount, time, ownership or lineage with editable facts and a clear reason.
- Recompute ordering from confirmed business timestamp/obligation intent, not from concurrent insertion order or a hardcoded `itemOrder`.
- Detect occupied member positions and cross-batch membership separately. Map wrapped SQL constraint errors to precise domain conflicts, with safe participant UUIDs.
- Preserve and expose an existing posted payment as the result for a duplicate transfer. Do not offer a second posting route.

Cancellation and recovery alone never authorize an identity merge. A change to evidence/identity/lifecycle must revalidate affected authorization, while unrelated participants remain untouched.

## 9. Intermediary collections

Model borrower-to-intermediary collection and intermediary-to-operator remittance separately, with explicit assignment/channel and linked evidence.

- A borrower slip can record a collection even if remittance is not yet evidenced. The displayed state must identify who holds the funds.
- Whether that collection immediately credits the borrower's debt follows an explicit supported operator policy/manual approval, not an inference from recipient name or a generic “post” confirmation.
- Remittance reconciles held collections. It must not credit the borrower twice if collection treatment already did so.
- Do not remove the current unsupported-attachment blocker until a real collection evidence transport and safe verification route exists, or the operator selects a supported evidence-optional channel with an explicit reason.
- The unified plan shows gross collected, borrower allocation, operator receipt and remaining intermediary-held balance as separate values.

## 10. Concurrency and bounded recovery

Separate two guarantees: no indefinite technical waits, and no repeated application recovery cycle without progress. Do not claim all possible SQL deadlocks are impossible.

Initial compatibility rollout retains the existing tenant-first mutex for participating financial writers. All interacting paths, including legacy endpoints, must acquire it before identity/borrower/batch/intake/loan locks; map and test nested calls before changing lock order. Fine-grained replacement is deferred until concurrency evidence proves equivalent identity/range protection. Moving external I/O and long calculations out of critical sections is mandatory in the first release.

Required execution sequence:

1. Inspect and calculate a plan from a consistent snapshot outside an exclusive financial lock.
2. Acquire transaction-local locks in the documented common order with a 2-second wait limit.
3. Re-read authorization, dependency versions, identities, evidence readiness and balances; reject stale plans before effects.
4. Apply the complete group and record its idempotent receipt in the same transaction.
5. Publish UI notifications through an after-commit/outbox mechanism, never as a pre-commit success signal.

Design targets: financial transaction statement budget 15 seconds, overall synchronous attempt budget 30 seconds, at most three full transaction attempts for replay-safe `40P01`/`40001`. Retry must fit the overall deadline. Treat lock timeout as retryable contention with same-key guidance, not a business blocker; do not turn it into an unbounded retry. Tune only after measured tests and report any changed targets in the plan.

Large calculations may use a durable background job; they must not retain a DB transaction while queued or computing. Persist operation identity, exact request fingerprint and progress. A resumed worker uses the same command and revalidates before commit. A committed response lost in transit resolves through the receipt; it never causes a second financial effect. Evidence upload success and ledger posting success are separate resumable milestones.

## 11. Action contracts and loop detection

Each unresolved condition returns a safe machine-readable action with current target UUIDs/revisions, required inputs, whether financial confirmation is needed, retry policy, and expected postcondition. All actions come from the same capability evaluator used by their execute handlers. Do not recommend an operation invalid for the current state or current actor.

Track a normalized state signature over relevant inputs, blockers, dependency versions and selected actions. Repeated automatic recovery reaching the same signature without changing evidence/facts/decisions is a cycle: stop automation, retain the item, and report the exact unresolved requirement and diagnostic ID. Do not count harmless repeated read-only inspection as a new recovery attempt.

Supported classes: edit facts, resolve identity, upload/replace evidence slot, continue successor, resume cancelled draft, bind recovered member, replan chronology, confirm dependency correction, refresh changed preview, retry transient contention, and retrieve committed result. Unknown errors retain user input and a diagnostic ID; they are defects to triage, not instructions to cancel/recreate.

## 12. Web/MCP and compatibility

Both interfaces consume the same service capabilities and plan. Keep existing screens/styles and Thai/English localization. UI provides intake, edit, selected count, ready/held groups, preview before/after, resume, correction and operation status without exposing low-level lifecycle machinery as required user steps.

Tool names and API routes are additive until compatibility is verified. Existing endpoints must use the shared validation/lock boundary or reject incompatible new states clearly. Synchronize tool schema annotations, frozen contract, plugin manifest/profile inventory, skills, evals and validator. Re-read actual inventories rather than using historical tool counts. MCP calls application services, not product REST.

Use additive schema migrations for stable workspace links, selection/membership events, evidence slots/attempt mappings and operation plans/receipts only where existing structures cannot represent the invariant. Preserve posted/cancelled history, old audit receipts and bank-reference uniqueness. A projection backfill is restartable, versioned and does not move money or fabricate confirmations.

## 13. Delivery and operational recovery

### Phase A — unblock supported existing cases

Complete recovered-item binding, evidence retry/slot compatibility, precise duplicate/member errors, legal next actions, lock/I/O boundaries, and an end-to-end recovery path for the known 10-slip scenario. Use existing recovery/identity/accounting services. An operational adapter is acceptable before the final UI only if it uses the same audited commands and exact preview; direct production SQL edits are not.

### Phase B — unified workflow and historical correction

Deliver the workspace selection model, full impact preview, backend dependency adapters, intermediary evidence/routing, Web/MCP parity, and the complete state/concurrency regression matrix. Phase A alone is not completion of this specification.

For the task's actual slips, prepare a fresh read-only impact report after implementation: inspect cancelled original items, all new drafts/staging, evidence and reference discrepancies, complete borrower portfolio, collection/remittance history and any later posting. Propose one disposition per actual transfer and exact per-contract allocation. Do not copy earlier OCR references or assume prior “no duplicate” statements were complete. Preserve Bangkok transfer times.

The user previously approved posting the listed payments and cancelling the two original drafts. That authorization is not evidence of intermediary remittance and does not authorize newly discovered downstream reversals or broad cleanup. Reuse existing authority for unchanged scope, and obtain only the additional concrete decision required by newly discovered effects. Deployment and unrelated production changes remain separately scoped.

Before rollout, rehearse migrations and legacy compatibility on disposable/restored data. Deploy only after authorization; verify version/migrations, internal MCP and frontend health. Keep a feature gate for new financial writers. Rollback disables new writers but preserves new lineage, receipts and evidence; do not run old writers against unsupported new states or drop recovery history.

## 14. Acceptance and verification

Every scenario below requires evidence that the expected money, evidence and audit invariants hold, and that a user/agent can reach a valid next action without a cancel/recreate loop.

| Scenario | Required outcome |
| --- | --- |
| Ten historical slips in random input order, two cancelled originals and one unresolved staging item | One disposition per transfer, correct confirmed dates/allocations, complete selected set, no duplicate posting |
| Edit unposted amount/time/borrower/contract and replace/remove an image | Only relevant revision/plan invalidated; no cancel required; missing required evidence clearly shown |
| Repeated failed/expired uploads for one slot | Slot count stable, attempts preserved, retry resumes or replaces attempt safely |
| Remove, pause, reselect and move an unposted item | Other items preserved; selections auditable; no phantom batch dependency |
| Cancel a recovery child and resume again | One active successor through an auditable chain; repeated request resumes it |
| Same payer/equal amount within minutes, distinct real transfers | Exact human decision permits both without exempting a third transfer |
| Same slip from another batch or after prior posting | Existing canonical/result exposed; at most one active financial effect |
| Day 20 posted before day 15 is imported | Scheduled unaffected case posts correctly; affected floating case produces complete compensating plan |
| Older pending unrelated item | No blanket borrower-wide blockage; related dependency still detected |
| Backdate affects renewal, settlement, waiver or remittance | Complete effect graph and supported correction action or exact additional decision; no hidden bypass |
| Collection before remittance, then remittance retry | Correct holder/debt policy; no second borrower credit |
| Two concurrent posts; post/cancel; finalize/cancel; merge/recovery; batch edit/post | Bounded outcome, shared lock order, no duplicate or partial financial effects |
| Response loss after commit, process restart, repeated idempotency key | Original receipt and actual outcome returned; payload mismatch rejected |
| Evidence or balance changes after preview | Stale plan produces a focused diff, retains selections, cannot post changed effects under old confirmation |
| Missing permission or cross-tenant evidence | No information leak or mutation; correct access/review action |
| Repeated resolver state | Cycle detected, no automatic infinite retry, exact unresolved input reported |

Add model/state-sequence tests composing import/edit/detach/recover/preview/post/cancel; verify supported blocker actions are legal and meet their postconditions. Property checks cover exact decimal totals, immutable posted history, one active posting per identity, evidence coverage, and idempotent results. Include large decimal values and Bangkok midnight boundaries.

Concurrency tests use controlled barriers on independent database connections within a serialized disposable test file; test both lock acquisition orders, rollback and committed-response loss. Other destructive DB test files remain serialized.

Release gates: backend disposable PostgreSQL suite without skipped changed financial invariants, backend typecheck, frontend tests/lint/build, plugin tests/validator, representative browser flows including Thai text, keyboard/focus and resumed errors, migration rehearsal, and actual-state read-only recovery report. No production test payments.

Completion means code verified, interfaces usable, deployment status reported separately, and the individually authorized backlog resolved with re-read payment history, schedule/accrual integrity and intermediary totals. “Build passes” alone is not completion.

## 15. Boundaries of this deliverable

This is the written design, not an implementation plan or an executed recovery. No tests, migrations, live financial operations or deployment are claimed by this document. The implementation plan must turn these invariants into ordered tasks and verification gates, with an isolated worktree and supervised tmux worker under repository policy after its approval.
