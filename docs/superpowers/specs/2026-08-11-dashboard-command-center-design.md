# Dashboard Daily Command Center Design

## Purpose

Turn the owner/manager dashboard from a wall of equally weighted metrics into a
daily operations workspace. Within a few seconds, an operator should understand
what cash is expected in, what must go out, the resulting net position, and the
next work item that needs attention.

The selected visual direction is stored at
`docs/superpowers/specs/assets/dashboard-command-center-reference.png`. It is a
hierarchy and layout target, not a new data contract: generated labels, times,
counts, and secondary facts must not be implemented unless existing APIs can
support them truthfully.

## Approved Direction: Daily Command Center

The page keeps the existing CreditSync dashboard shell, dark/light theme,
Thai/English localization, Lucide icon language, and role gate. The content is
reordered around daily action:

1. Page context and actions.
2. One consolidated cash summary.
3. A prioritized work queue.
4. Borrower and fund due queues.
5. Funding, reconciliation, and profitability detail.

The page must not introduce charts, forecasts, intraday times, or workflow
states that the backend does not currently own.

## Header And Actions

- Use one `h1`: `Daily Operations` / `งานดำเนินงานวันนี้`.
- Supporting copy identifies the business date in `Asia/Bangkok` and explains
  that the view combines collections, obligations, and exceptions.
- Primary action: `Record borrower payment` / `บันทึกรับชำระลูกหนี้`, routed
  to `/transactions/new`.
- Secondary actions: `Open matching` and `Open funds`.
- On mobile, the primary action is full width. Secondary actions remain visible
  but visually quieter and may share a row.

## Today Cash Summary

- Replace the first four equal KPI cards with one grouped summary surface.
- Show due from borrowers, due to funds, and net position in that order so the
  relationship reads as inflow minus outflow equals net.
- Keep the amounts visually connected; do not present them as three unrelated
  cards.
- Use green/red as reinforcement only. Each amount retains an explicit text
  label and the net result includes a positive/negative state label.
- Show overdue borrower/fund counts as compact supporting context, not a fourth
  hero metric.
- Do not show a fake update timestamp. The current APIs do not return one.

## Priority Work Queue

Create a ranked list from data already returned by the six dashboard reads.
Ranking is deterministic and does not make financial decisions:

1. Overdue borrower installments.
2. Overdue fund obligations.
3. Underfunded loans.
4. Fund repayments missing a schedule link.
5. Unallocated drawdowns.
6. Pending manual reviews or bank imports.
7. Borrower payments missing slips.

Each row includes a localized label, count, severity text/icon, and one route to
the existing owning workflow. Zero-count rows are omitted. The first row is not
automatically executed; the operator must select it. If every count is zero,
show a calm localized `No urgent work right now` state.

Routes are explicit: overdue borrower installments open `/transactions/new`,
overdue fund obligations and unallocated drawdowns open `/funds`, underfunded
loans open `/matching`, missing schedule links open `/reconciliation`, and
pending reviews/imports or missing slips open `/payments`. These links open the
existing destination without silently selecting, matching, or posting a record.

The queue is a presentation derived from existing reads. It adds no backend
write, automatic matching, posting, payment allocation, or risk score.

## Due Queues

- Borrower and fund obligations remain separate because their actions and
  accounting meaning differ.
- Use one grouped surface per queue with lightweight row separators instead of
  a nested card for every installment.
- Each row shows identity, contract/drawdown reference, due date, exact amount,
  localized status, overdue age when available, and its existing action.
- Display at most five rows initially. A localized `View all` control reveals
  the remaining items in place without creating a new route.
- On desktop the two queues sit side by side. On mobile they stack immediately
  after the priority queue.
- Raw backend values such as `daily`, `weekly`, `monthly`, `due`, and `overdue`
  must be mapped to locale keys before display.

## Secondary Operations Detail

Funding alerts and reconciliation remain available below the daily queues:

- Funding alerts use concise rows for underfunded loans and unallocated
  drawdowns with their existing Matching/Funds destinations.
- Reconciliation counts use one grouped list. Counts with an existing owning
  route are interactive; unsupported destinations remain labelled read-only
  facts rather than fake links.
- Profitability becomes one quiet summary row for realized spread, unrealized
  spread, and realized ROI. It is clearly labelled as portfolio performance,
  not today's cash.
- On mobile these three sections use accessible disclosure controls and start
  collapsed so daily work is not pushed several screens down. Desktop shows
  them expanded.

## Responsive Behavior

### Desktop (`>= 1280px`)

- Retain the fixed sidebar.
- Cash summary spans the content width.
- Priority queue is the dominant left area; overdue context or compact
  exceptions occupy the right area only when useful.
- Borrower and fund due queues use two equal columns.
- Target a useful first viewport at 1440 x 1024: header, cash summary, priority
  queue, and the start of the due queues must be visible without scrolling.

### Tablet (`768px` to `1279px`)

- Summary stays grouped and may wrap into a three-column grid.
- Priority queue spans full width.
- Due queues stack when their rows would become cramped.

### Mobile (`< 768px`)

- Order is header/actions, cash summary, priority queue, borrower queue, fund
  queue, then collapsed secondary detail.
- Avoid one-card-per-metric stacking.
- Buttons and disclosure controls have at least 44px touch targets.
- Long Thai labels wrap without shrinking below readable body text.
- No horizontal scrolling at 320px CSS viewport width or 200% browser zoom.

## Data Contracts And Financial Precision

Dashboard money must follow the repository financial rules:

- Backend dashboard endpoints return public money as two-decimal decimal
  strings, including summary amounts, queue amounts, funding amounts, and
  profitability amounts.
- Counts and installment numbers remain integers.
- Percentages cross the public interface as decimal strings.
- Backend calculations use `decimal.js`; frontend comparisons and formatting
  use shared decimal-string helpers and never `Number`, `parseFloat`, or
  JavaScript arithmetic.
- No financial record, schedule, or loan term is mutated by this redesign.

This is an intentional additive contract correction across the existing
dashboard backend and frontend. Tests must cover amounts beyond JavaScript's
safe integer range.

## Loading, Failure, And Empty States

- Load the six dashboard reads independently so one unavailable section does
  not erase healthy data from the others.
- The cash summary, priority inputs, due queues, alerts, reconciliation, and
  profitability each own loading and error state.
- Use shaped skeletons for the summary and queues; do not use `...` as the only
  loading signal.
- A failed section shows a localized inline error and retry action.
- Never substitute zero for unavailable financial data. Use an explicit
  unavailable state until a successful response provides zero.
- Empty due queues and a zero priority queue receive distinct positive empty
  states.
- A retry repeats only the failed request unless a full refresh is explicitly
  requested.

## Component Boundaries

- `DashboardPage` owns role gating, section composition, and orchestration.
- `useDashboardData` owns independent request states and scoped retries.
- `TodayCashSummary` owns the inflow/outflow/net relationship.
- `PriorityWorkQueue` receives normalized counts and routes but performs no
  financial action.
- `DueQueue` is a shared presentation component parameterized for borrower or
  fund rows; route callbacks remain owned by the page.
- `DashboardSecondaryDetails` owns funding, reconciliation, and profitability
  disclosures.
- Dashboard public types and exact-value formatters live outside the page so
  backend contract tests and UI tests share stable names.

Do not refactor unrelated dashboard layout, global navigation, or other product
pages.

## Localization And Accessibility

- Update `frontend/src/locales/en.json` and `frontend/src/locales/th.json`
  together for every visible string and status label.
- Use one `h1`, ordered `h2` section headings, labelled regions, semantic lists
  or tables, and actual buttons for actions/disclosures.
- Priority severity is conveyed through label, icon, and count, not color alone.
- Loading sections expose `aria-busy`; errors and retry results use appropriate
  live announcements without moving focus unexpectedly.
- Visible keyboard focus is required for every queue row, action, retry, and
  disclosure.
- Reduced-motion preferences disable nonessential transition movement.
- Screenshot review cannot establish WCAG compliance; keyboard, zoom, and
  assistive-technology semantics require automated and manual verification.

## Verification

- Backend unit/integration tests verify exact decimal-string dashboard outputs,
  values beyond the safe integer range, and unchanged tenant/role scoping.
- Frontend tests verify hierarchy, localized statuses, exact money formatting,
  priority ordering, zero states, scoped retries, disclosures, and routes.
- Responsive capture covers 1440 x 1024, 834 x 1194, 390 x 844, and 320px width.
- Keyboard QA covers primary/secondary actions, priority items, due rows,
  retries, `View all`, and disclosures.
- Run backend typecheck and applicable dashboard tests, then frontend full test,
  lint, and build.
- Compare the 1440 x 1024 implementation capture against the selected reference
  and record Product Design QA in `design-qa.md`; generated text/data is not a
  fidelity requirement when it conflicts with this specification.

## Out Of Scope

- New charts, forecasts, intraday cash timing, or historical trend endpoints.
- Automatic prioritization based on inferred customer risk.
- Automatic matching, posting, collection, allocation, or fund repayment.
- New payment, matching, reconciliation, or funding routes.
- Changes to non-admin dashboard access.
- Redesigning the global sidebar, landing page, login, or settings page.
