# Sequential Collection Queue and Payment Holidays Design

## Goal

Support borrowers who receive multiple daily-loan advances with independently agreed prices or rates but make only one daily payment. Each loan remains a separate financial contract, while a borrower-scoped collection queue determines which loan is currently being collected. Approved payment holidays affect only the current loan; downstream start dates remain derived projections and therefore move without rewriting downstream schedules or creating synthetic holiday records.

## Product decisions

- Each advance remains a distinct loan with its own principal, pricing, installment amount, installment count, funding, disbursement evidence, transactions, and profitability.
- A queue sequences collection; it does not consolidate principal, refinance contracts, or change financial terms.
- One queue has at most one collecting loan. Later loans are `queued` and cannot become overdue before they become the collecting member.
- A queued loan's start and due dates are projections derived from the actual/projected completion of its predecessor. They become effective dates only when the member is promoted to `collecting`.
- An approved holiday belongs only to the affected collecting loan. It consumes no installment, is excluded from arrears, and extends projected completion. Downstream projections follow automatically through dependency calculation.
- Waiting time does not change a queued loan's agreed price. Any added waiting charge requires a separate previewed, confirmed, append-only adjustment; it is never inferred.
- Existing active loans remain outside a queue until explicitly enrolled. Migration must not change their dates, balances, or status.

## Terms

- **Financial loan:** the existing immutable active loan contract and schedule.
- **Collection queue:** the borrower-scoped ordered sequence governing daily collection priority.
- **Queue member:** a loan's position and collection lifecycle within a queue.
- **Contract schedule:** the immutable monetary installment components generated at activation.
- **Effective collection calendar:** the business-date projection produced from the contract installment sequence, queue dependency, recurring non-collection days, approved holidays, and posted payments.
- **Payment holiday:** an approved exception for one or more business dates on which a collecting member is not expected to pay.

## Queue lifecycle

### Creating the first queue

An operator may create a queue from one eligible scheduled daily loan. The loan must belong to the borrower and tenant, be active or paid, and not already be an active member of another queue. An active loan becomes `collecting`; a paid loan can only be enrolled as a completed historical head when immediately followed by a new queued member.

Queue state is `active`, `completed`, or `cancelled`. Cancellation is permitted only before any queued member has been promoted or financially affected; otherwise members must be removed or corrected through explicit compensating workflows.

### Adding a follow-on advance

The workflow is `preview -> explicit confirmation -> execute`:

1. Select the borrower's active queue and enter the new loan's independent daily terms, funding allocation, and actual payout workflow.
2. Preview the new loan contract and its placement after the current tail.
3. Show principal, total repayment, daily installment, installment count, independent interest/price, actual cash payout, predecessor, projected first collection date, and projected completion date.
4. Confirm with a reason and idempotency key.
5. Create/activate and disburse according to existing loan and disbursement boundaries, then append it as `queued`.

The queue does not make activation and payout interchangeable. An activated queued loan may have zero or more append-only disbursement events, and its projection must visibly warn if actual payout is incomplete or differs from attributed principal.

### Promotion

When posting a payment completes the current member's net active obligation, the same database transaction locks the queue and members, marks the member `completed`, snapshots its actual completion business date, and promotes the next eligible member to `collecting` with an effective collection start date.

Default promotion is the next valid collection business date, not necessarily the payment timestamp's next calendar day. It respects the queue's recurring calendar. If the operator posts an explicit close-out with surplus cash, allocation into the next member must be shown in the payment preview and explicitly confirmed; promotion alone never silently consumes the surplus.

If the current member is reversed back to an outstanding state after promotion, the operation must stop for a dedicated queue-impact preview. It must not silently demote a successor that already has payments or adjustments. Resolution requires a compensating correction or an authorized restructure.

## Effective collection calendar

### Monetary rows versus collection dates

Existing `loan_schedules` retain installment number and exact principal, interest, fee, total, and remaining-due accounting. For queue members, their original due dates are not rewritten when a predecessor or holiday changes. Read models pair each unpaid monetary row with an effective expected date computed by the calendar service.

For `collecting` members, calculation begins at the member's effective start and walks collection dates, skipping:

- configured recurring non-collection weekdays;
- approved payment-holiday dates;
- any future calendar exclusions explicitly configured for that queue.

Paid schedule rows retain the effective date used when payment was posted. Unpaid rows are projections and may move when a new holiday is approved or reversed. This separates immutable financial history from mutable operational forecasting.

For `queued` members:

`projectedStart(member N) = nextCollectionDate(projectedCompletion(member N-1))`

The service then lays the member's remaining installment count over valid dates. A holiday on A changes A's projected completion, which changes B's projected start by derivation. No B schedule update or B holiday is written.

### Calendar configuration

Version one supports a queue-level set of recurring collection weekdays, defaulting to every day to preserve current daily-loan behavior. Changing recurring weekdays is a separate previewed operation because it can move many projections. Public holidays are not assumed automatically; an operator must configure a queue exclusion or borrower holiday so the accounting expectation matches the real agreement.

All dates use `Asia/Bangkok`, public date values use `YYYY-MM-DD`, and timestamps remain ISO 8601. Date projection must not use browser locale or UTC date truncation.

## Payment-holiday lifecycle

Holiday workflow is `preview -> approve/confirm -> execute`. A rejected request is retained as an operational record but has no calendar or financial effect. Executed events are append-only and may be reversed only through a compensating holiday reversal.

Required input:

- queue and collecting loan public UUIDs;
- one date or a bounded inclusive date range;
- customer reason and internal note;
- charge policy and exact policy inputs;
- actor, source, request/correlation ID, and idempotency key;
- explicit confirmation of the latest preview.

Supported policies:

- `free`: no charge; collection date is skipped.
- `fixed_fee`: one exact fee for the request, not multiplied unless the preview explicitly says so.
- `per_day_fee`: exact fee multiplied by eligible holiday days.
- `daily_interest`: backend-calculated exact interest using a snapshotted rate basis and the number of eligible holiday days.
- `custom_charge`: exact operator-entered charge requiring a non-blank justification and manager/owner approval.
- `waived_installment`: removes an agreed installment obligation and requires owner approval; this is a distinct concession, not merely a date shift.

The preview returns:

- eligible dates, conflicts, and dates already paid or already covered by another exclusion;
- original and projected current-loan completion;
- original and projected downstream starts/completions;
- charge principal basis, rate snapshot/formula, exact charge, and classification;
- remaining installment count, added tail rows if needed, and exact final installment;
- before/after queue revision and an expiring preview hash.

`free`, `fixed_fee`, `per_day_fee`, `daily_interest`, and `custom_charge` skip collection dates without consuming scheduled installments. Charges are append-only `loan_adjustments` classified as holiday fee or holiday interest and linked to the holiday event. They do not mutate principal or original interest components. The charge is collected after the contract schedule unless a later explicit settlement says otherwise; the schedule extension uses the normal daily amount and an exact smaller final row when necessary.

`waived_installment` writes a compensating waiver adjustment against the selected unpaid monetary row. It must never edit or delete that row. The preview must identify the exact waived principal/interest/fee composition and resulting funding/profitability effects.

### Date and conflict rules

- Today and future dates may be requested for the current collecting member.
- A manager or owner may enter a past holiday only if the date has no posted payment, no settlement, and no conflicting finalized financial action. The preview labels it backdated and requires a reason. It recalculates operational arrears from that date forward without modifying posted transactions.
- A holiday cannot be approved for a queued, completed, defaulted, or cancelled member.
- Overlapping executed holidays are rejected. Retrying the same intent returns the same result through idempotency.
- A payment may still arrive on an approved holiday. Its preview warns that no payment was expected and requires an explicit choice to apply it to the oldest outstanding row or leave it unmatched; the holiday itself is not silently cancelled.

## Data model

### `collection_queues`

- internal ID and public UUID;
- tenant and borrower foreign keys;
- status;
- collection timezone fixed to `Asia/Bangkok` in this release;
- recurring collection weekday mask;
- monotonic `revision` for stale-preview detection;
- created/updated actor and timestamps.

Constraints enforce tenant-safe borrower references and at most one active queue per borrower in version one.

### `collection_queue_members`

- queue and loan foreign keys;
- immutable sequence number;
- predecessor member ID for explicit dependency evidence;
- state: `queued`, `collecting`, `completed`, `removed`;
- projected start/completion cache fields for fast reads only;
- effective start and actual completion dates;
- promotion/removal reason, actor, and timestamps.

Constraints enforce tenant-safe references, one membership per loan, unique sequence per queue, and a partial unique index allowing only one `collecting` member per queue. Projection caches are never financial sources of truth and may be rebuilt.

### `collection_calendar_exclusions`

Stores queue-wide dated exclusions separately from borrower-specific holidays. Each row has date/range, reason, lifecycle, actor, and audit context. Version one need not ship a separate UI if recurring weekdays and payment holidays cover the operational need, but the projection boundary should support it without changing financial tables.

### `payment_holiday_requests`

- public UUID, tenant, queue/member/loan references;
- requested date range and eligible-date snapshot;
- status: `preview`, `executed`, `rejected`, `reversed`, `expired`;
- policy, exact inputs, exact calculated charge, calculation snapshot;
- customer reason, internal note, approval/rejection/reversal reason;
- preview hash, queue revision, expiry;
- execute and reversal idempotency keys;
- created/approved/rejected/reversed actors and timestamps;
- linked adjustment/reversal public IDs where applicable.

Database constraints close enums, prohibit negative money, require policy-specific values, and enforce tenant-scoped foreign keys. Executed and reversed rows are immutable at the database boundary except for the one-way reversal metadata transition.

### Effective-date snapshots

Add effective-collection metadata to payment allocations or a dedicated append-only allocation-date table so every posted schedule allocation records the effective expected date and calendar revision used at posting. This prevents later projection changes from rewriting the historical meaning of a payment.

## Backend boundaries

Create isolated services:

- `collection-calendar`: pure Decimal/date kernel for valid dates and projection chains;
- `collection-queue-service`: list, preview append, execute append, and guarded promotion;
- `payment-holiday-service`: preview, execute, reject, reverse, and linked adjustments;
- payment integration: select only the collecting member for automatic matching and promote atomically on completion;
- payment-health integration: use effective expected dates and approved exclusions rather than raw queued schedule dates.

All financial calculations remain backend-owned and use `decimal.js`. Services accept public UUIDs and two-decimal strings, lock queue/member/loan/schedule rows in deterministic order, verify the latest queue revision and financial state hash, and append audit history with useful before/after state.

Projection is deterministic from persisted inputs. Cached dates are refreshed after holiday execution/reversal, payment post/reversal, recurring-calendar changes, queue append/removal, and promotion. A cache failure must fail the write transaction rather than leave a misleading committed projection.

## REST contract

Proposed authenticated endpoints:

- `GET /borrowers/:borrowerPublicId/collection-queue`
- `POST /collection-queues/append/preview`
- `POST /collection-queues/append/:previewPublicId/execute`
- `POST /collection-queues/:queuePublicId/calendar/preview`
- `POST /collection-queues/:queuePublicId/calendar/:previewPublicId/execute`
- `POST /payment-holidays/preview`
- `POST /payment-holidays/:holidayPublicId/execute`
- `POST /payment-holidays/:holidayPublicId/reject`
- `POST /payment-holidays/:holidayPublicId/reverse`

Reads return exact money strings, public UUIDs, contract terms, member states, actual dates, derived projections, revision, holiday summaries, warnings, and safe audit references. Execute/reverse endpoints require `Idempotency-Key`, the latest preview hash, explicit confirmation, and reason. Closed request schemas reject unknown fields.

## MCP and CreditSync plugin

If MCP support is included in implementation scope, synchronize the frozen backend contract, plugin manifest/version, skills, validator, and eval scenarios. Add read-only queue inspection and destructive preview/execute boundaries rather than exposing direct schedule mutation.

Candidate tools:

- `collection.queue.get` (read-only);
- `collection.queue.append.preview` and `collection.queue.append.execute`;
- `payment.holiday.preview`, `payment.holiday.execute`, and `payment.holiday.reverse`.

Agent orchestration must inspect the borrower portfolio and queue before previewing. It may execute only the exact latest ready preview after human confirmation. Ambiguous borrower/loan identity, stale revision, overlapping holiday, already-posted payment, queued-loan holiday, funding gap, or idempotency conflict stops for human review.

## Web experience

### Borrower collection queue

Add a localized queue section to borrower detail and a compact summary on loan detail. Show:

- the single daily collection expectation prominently;
- current collecting loan and remaining installments/amount;
- ordered follow-on advances with their independent terms;
- projected start and completion labels clearly marked as estimates;
- actual payout and funding warnings;
- recent holidays and their policy/charge;
- actions to add a follow-on advance or request a holiday.

Do not present the queue total as one consolidated loan balance. Show a queue operational total alongside per-contract principal, price, and outstanding obligation.

### Holiday preview

The form selects date/range, reason, and policy. Policy-specific inputs appear only when needed. The confirmation surface shows a compact before/after timeline, exact added charge, current-loan tail movement, downstream projected movement, and approval requirement. Thai and English copy must be updated together.

### Payment Inbox

Automatic proposals target only the borrower's collecting member and its oldest outstanding effective row. The review screen shows the contract and queue position. If no collecting member exists or the queue state is inconsistent, the proposal is `reviewRequired`; it must not guess a queued target.

## Roles and approvals

- `collector`: request a holiday and prepare previews; may execute a free holiday if tenant policy permits.
- `manager`: execute free, fixed-fee, per-day-fee, and daily-interest holidays; approve guarded backdating.
- `owner`: execute custom-charge and waived-installment concessions, calendar policy changes, and exceptional queue correction.
- `viewer`: read-only.

Initial implementation may conservatively require manager/owner for all holiday execution while preserving these policy distinctions for later tenant configuration.

## Error handling

Stable domain errors include:

- `ACTIVE_COLLECTION_QUEUE_EXISTS`
- `LOAN_ALREADY_QUEUED`
- `QUEUE_HAS_COLLECTING_MEMBER_CONFLICT`
- `QUEUE_PREVIEW_STALE`
- `LOAN_NOT_QUEUE_ELIGIBLE`
- `HOLIDAY_MEMBER_NOT_COLLECTING`
- `HOLIDAY_DATE_CONFLICT`
- `HOLIDAY_HAS_POSTED_PAYMENT`
- `HOLIDAY_PREVIEW_STALE`
- `HOLIDAY_APPROVAL_REQUIRED`
- `QUEUE_PROMOTION_BLOCKED`
- `QUEUE_REVERSAL_IMPACT_REVIEW_REQUIRED`

Errors expose safe public identifiers and aggregate conflict information only. They never expose evidence contents, borrower identity values, signed URLs, tokens, or internal stack traces.

## Verification

### Pure unit coverage

- every-day and selected-weekday projection across Bangkok month/year boundaries;
- A holiday shifts A completion and derived B/C projections without writing B/C holidays;
- multiple holidays, date ranges, exclusions, exact tail remainder, and no floating-point money;
- each charge policy and snapshotted daily-interest formula;
- deterministic projection from the same revision and state.

### Disposable PostgreSQL integration coverage

- tenant isolation and closed constraints;
- one active queue per borrower and one collecting member per queue under concurrency;
- append preview staleness and idempotent execution;
- holiday preview/execute/reverse, overlap races, backdate guards, immutable executed rows, and adjustment compensation;
- payment post completes A and atomically promotes B;
- payment reversal after promotion stops when B has downstream entries;
- automatic payment matching never targets queued B while A is collecting;
- effective-date snapshots remain unchanged after later holidays;
- existing non-queued loans retain current payment and arrears behavior.

### Frontend and contract coverage

- Thai/English queue, estimate, holiday, policy, charge, warning, and error copy;
- mobile/desktop queue ordering and before/after preview accessibility;
- exact money formatting beyond JavaScript safe integers;
- payment review identifies the collecting contract;
- REST DTO validation, authorization, idempotency headers, and stale-preview behavior;
- synchronized MCP/plugin tests and validator if tools are added.

Run the disposable PostgreSQL backend suite serially, backend typecheck, frontend tests/lint/build, and plugin validator/tests when applicable. A skipped database suite is insufficient for queue uniqueness, promotion, holiday immutability, and append-only adjustment invariants.

## Delivery slices

1. Pure calendar kernel, queue schema/read model, explicit enrollment, and projection UI.
2. Append-follow-on preview/execute with independent terms and funding/disbursement integration.
3. Payment matching, atomic promotion, payment health, and reversal guards.
4. Holiday preview/execute/reverse with free and fixed-fee policies.
5. Daily-interest, custom-charge, waived-installment approvals, recurring-calendar management, and MCP/plugin synchronization.

Slices must not expose a write UI before its invariants and database-backed tests are active. The first production migration should enroll no borrower automatically; operators opt in after reviewing each existing portfolio.

## Out of scope

- Combining multiple loans into one accounting contract.
- Repricing a queued loan merely because its predecessor is delayed.
- Editing or deleting posted payments, active terms, schedules, adjustments, or executed holidays.
- Silently allocating payment surplus into the next contract.
- Automatic Thai public-holiday imports.
- Multiple simultaneous collection queues for one borrower in version one.
