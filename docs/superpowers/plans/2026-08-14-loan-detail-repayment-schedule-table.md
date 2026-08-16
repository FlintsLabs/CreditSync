# Loan Detail Repayment Schedule Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the loan detail repayment schedule's nested installment cards with one compact, responsive shadcn-style table.

**Architecture:** Add presentation-only shadcn table primitives to the shared UI layer, then compose them inside the existing `LoanDetail` repayment schedule card. Keep fetching, ordering, the eight-row cap, exact money formatting, empty-state behavior, and status mapping unchanged.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4, react-i18next, Vitest, Testing Library, Bun.

## Global Constraints

- Preserve `schedule.slice(0, 8)` and the API-provided row order.
- Render financial strings only through the existing `money`/`formatMoneyExact` path; do not use JavaScript `Number` or floating-point calculations.
- Update `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together for all new column labels.
- Preserve the current empty state and status variants: `overdue` is `destructive`, `paid` is `secondary`, and every other status is `outline`.
- Do not change backend code, API contracts, financial records, or schedule calculations.
- Before committing, add the UI change to the newest applicable version/date section of `CHANGELOG.md`; do not modify `README.md` because setup and workflow expectations are unchanged.
- Keep unrelated working-tree changes unstaged and out of the commit.

---

### Task 1: Responsive Repayment Schedule Table

**Files:**
- Create: `frontend/src/components/ui/table.tsx`
- Create: `frontend/tests/loan-detail-schedule.vitest.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx:787`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `LoanScheduleRow`, `money(value)`, `t(key)`, `schedule.slice(0, 8)`, `Badge`, and `cn(...classes)`.
- Produces: shared `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableHead`, `TableRow`, `TableCell`, and `TableCaption` React components; a semantic four-column repayment schedule table.

- [ ] **Step 1: Write the focused failing component test**

Create `frontend/tests/loan-detail-schedule.vitest.tsx` using the same `MemoryRouter`, mocked `api`, session mocks, and child-panel mocks as `loan-detail-activation.vitest.tsx`. Return an active monthly loan from `GET /loans/:id`, a borrower from `GET /borrowers/:id`, empty allocation responses, and nine schedule rows from `GET /loans/:id/schedule`.

Use distinguishable fixtures such as:

```tsx
const schedule = Array.from({ length: 9 }, (_, index) => ({
    id: `schedule-${index + 1}`,
    publicId: `schedule-public-${index + 1}`,
    installmentNo: index + 1,
    dueDate: `2026-07-${String(index + 1).padStart(2, "0")}`,
    scheduledTotal: "200.00",
    remainingDue: index === 1 ? "0.00" : "200.00",
    status: index === 0 ? "overdue" : index === 1 ? "paid" : "scheduled",
}));
```

After `await appI18n.changeLanguage("th")` and rendering, locate the repayment schedule section by its heading, then assert:

```tsx
const section = screen.getByRole("heading", { name: "ตารางผ่อน" }).closest("div.rounded-lg");
expect(section).not.toBeNull();
const table = within(section as HTMLElement).getByRole("table");
expect(within(table).getByRole("columnheader", { name: "งวด" })).toBeInTheDocument();
expect(within(table).getByRole("columnheader", { name: "วันครบกำหนด" })).toBeInTheDocument();
expect(within(table).getByRole("columnheader", { name: "ยอดคงค้าง" })).toBeInTheDocument();
expect(within(table).getByRole("columnheader", { name: "สถานะ" })).toBeInTheDocument();
expect(within(table).getAllByRole("row")).toHaveLength(9); // header + eight data rows
expect(within(table).getByText("งวด #1")).toBeInTheDocument();
expect(within(table).getByText("2026-07-01")).toBeInTheDocument();
expect(within(table).getAllByText("฿200.00").length).toBeGreaterThan(0);
expect(within(table).getByText("ค้างชำระ")).toBeInTheDocument();
expect(within(table).getByText("ชำระแล้ว")).toBeInTheDocument();
expect(within(table).queryByText("งวด #9")).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd frontend && bun run test -- tests/loan-detail-schedule.vitest.tsx
```

Expected: FAIL because the repayment schedule is currently a collection of bordered `div` cards and has no semantic table or column headers.

- [ ] **Step 3: Add the shared shadcn table primitives**

Create `frontend/src/components/ui/table.tsx` with `React.forwardRef` components following the project's existing `Card.tsx` conventions. Use these exact base classes:

```tsx
Table wrapper: "relative w-full overflow-auto"
table: "w-full caption-bottom text-sm"
TableHeader: "[&_tr]:border-b"
TableBody: "[&_tr:last-child]:border-0"
TableFooter: "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0"
TableRow: "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted"
TableHead: "h-10 px-2 text-left align-middle font-medium text-muted-foreground sm:px-4 [&:has([role=checkbox])]:pr-0"
TableCell: "p-2 align-middle sm:p-4 [&:has([role=checkbox])]:pr-0"
TableCaption: "mt-4 text-sm text-muted-foreground"
```

Each primitive merges caller classes with `cn`, forwards its ref and native attributes, and sets a display name. `Table` wraps the native table in the responsive wrapper and forwards the ref to the native table.

- [ ] **Step 4: Add paired localized column labels**

Add the following nested object under `loanDetail` in both locale files:

```json
// frontend/src/locales/en.json
"scheduleColumns": {
  "installment": "Installment",
  "dueDate": "Due date",
  "remainingDue": "Remaining due",
  "status": "Status"
}
```

```json
// frontend/src/locales/th.json
"scheduleColumns": {
  "installment": "งวด",
  "dueDate": "วันครบกำหนด",
  "remainingDue": "ยอดคงค้าง",
  "status": "สถานะ"
}
```

- [ ] **Step 5: Replace installment cards with the table**

Import the required primitives in `LoanDetail.tsx`:

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../components/ui/table";
```

Keep the current `schedule.length === 0` branch unchanged. Replace only the non-empty `space-y-2` card list with:

```tsx
<Table className="min-w-[32rem]">
    <TableHeader>
        <TableRow className="hover:bg-transparent">
            <TableHead>{t("loanDetail.scheduleColumns.installment")}</TableHead>
            <TableHead>{t("loanDetail.scheduleColumns.dueDate")}</TableHead>
            <TableHead className="text-right">{t("loanDetail.scheduleColumns.remainingDue")}</TableHead>
            <TableHead className="text-right">{t("loanDetail.scheduleColumns.status")}</TableHead>
        </TableRow>
    </TableHeader>
    <TableBody>
        {schedule.slice(0, 8).map((row) => (
            <TableRow key={row.id}>
                <TableCell className="font-medium">
                    {t("loanDetail.installmentLabel", { defaultValue: "Installment #{{id}}", id: row.installmentNo })}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{row.dueDate}</TableCell>
                <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">{money(row.remainingDue)}</TableCell>
                <TableCell className="text-right">
                    <Badge variant={row.status === "overdue" ? "destructive" : row.status === "paid" ? "secondary" : "outline"}>
                        {t(`loans.paymentHealth.scheduleStatus.${row.status}`, { defaultValue: row.status })}
                    </Badge>
                </TableCell>
            </TableRow>
        ))}
    </TableBody>
</Table>
```

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```bash
cd frontend && bun run test -- tests/loan-detail-schedule.vitest.tsx
```

Expected: PASS with one header row, eight schedule rows, localized headers and badges, exact money formatting, and no ninth installment.

- [ ] **Step 7: Record the implementation before committing**

Under the newest applicable `## vX.Y.Z - YYYY-MM-DD` heading in `CHANGELOG.md`, add or reuse `### Changed` and add one concise bullet:

```markdown
- Replaced nested repayment-schedule cards on loan details with a compact responsive table and localized column headers.
```

Verify the version/date and section accurately describe the staged UI change. Do not stage unrelated existing changelog edits.

- [ ] **Step 8: Run all frontend verification gates**

Run sequentially:

```bash
cd frontend && bun run test
cd frontend && bun run lint
cd frontend && bun run build
git diff --check
```

Expected: every command exits zero. Existing non-fatal Vite chunk-size advisories may remain; any test, lint, typecheck, build, or whitespace error must be resolved before completion.

- [ ] **Step 9: Inspect and commit only the scoped change**

Inspect `git status --short` and `git diff` first. Stage only the new table primitive, focused test, `LoanDetail.tsx`, paired locale files, and the exact changelog hunk belonging to this change. Commit with:

```bash
git commit -m "fix: compact loan repayment schedule"
```

After committing, confirm the commit contains no backend migration, schema, identity-card, or other unrelated files.
