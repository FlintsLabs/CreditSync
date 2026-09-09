# Loan Repayment History Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate mobile repayment-history list and hand-written desktop table with one compact responsive shadcn-style table matching the repayment schedule.

**Architecture:** Compose the existing shared table primitives in `LoanRepaymentHistory` for every breakpoint. Keep all data and navigation flows unchanged while consolidating exact non-zero posted-component rendering into one allocation presentation path.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4, decimal.js, react-i18next, Vitest, Testing Library, Bun.

## Global Constraints

- Preserve the existing `GET /loans/:id/payment-intakes` request and API row order.
- Use `formatMoneyExact` for every displayed amount and `Decimal` for zero filtering; never use JavaScript `Number` for money.
- Preserve status-to-Badge variants and payment-review navigation URLs.
- Keep loading, error, empty state, record-repayment button, mobile navigation to the transaction form, desktop quick-capture dialog, and save workflow unchanged.
- Reuse `frontend/src/components/ui/table.tsx`; do not create another table primitive.
- Do not modify backend, database, APIs, financial records, MCP, plugin, or deployment configuration.
- Before committing, update the newest applicable `CHANGELOG.md` version/date and change-type section.
- Keep unrelated working-tree changes unstaged and out of the commit.

---

### Task 1: Unified Responsive Repayment History Table

**Files:**
- Modify: `frontend/tests/loan-repayment-history.vitest.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanRepaymentHistory.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `PaymentIntakeHistoryItem`, `PostedComponents`, `statusVariant`, `formatMoneyExact`, `Decimal`, `openIntake(publicId)`, `Table`, `TableHeader`, `TableBody`, `TableHead`, `TableRow`, and `TableCell`.
- Produces: one semantic six-column repayment-history table on every viewport and `postedComponentEntries(item)` returning exact non-zero posted components in principal/interest/fee/penalty order.

- [ ] **Step 1: Rewrite the focused presentation test to require one table**

In `frontend/tests/loan-repayment-history.vitest.tsx`, replace the test named `renders a flat mobile row with only non-zero posted components and full-row navigation` with:

```tsx
test("renders one responsive repayment table with exact allocation details and review navigation", async () => {
    const user = userEvent.setup();
    render(
        <MemoryRouter initialEntries={[`/loans/${LOAN_ID}`]}>
            <LoanRepaymentHistory loanPublicId={LOAN_ID} borrowerName="Borrower A" />
            <LocationDisplay />
        </MemoryRouter>
    );

    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Received at" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Received amount" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Bank reference" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Latest allocation" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(within(table).getByText("TRANSFER-001")).toBeInTheDocument();
    expect(within(table).getByText(/Principal.*100\.00/)).toBeInTheDocument();
    expect(within(table).getByText(/Interest.*25\.00/)).toBeInTheDocument();
    expect(within(table).queryByText(/Fee.*0\.00/)).not.toBeInTheDocument();
    expect(within(table).queryByText(/Penalty.*0\.00/)).not.toBeInTheDocument();
    expect(within(table).getByText("Posted")).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-repayment-row")).not.toBeInTheDocument();

    await user.click(within(table).getByRole("button", { name: "Open payment review" }));
    expect(screen.getByText(`/payments?intake=019c3a5a-94ce-7f2c-8b08-f56852dca7a6&loanId=${LOAN_ID}`)).toBeInTheDocument();
});
```

The component currently has no standalone status-column translation. Add and consistently use the paired `loanDetail.repaymentHistory.statusColumn` key defined in Step 5.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd frontend && bun run test -- tests/loan-repayment-history.vitest.tsx
```

Expected: FAIL because the current desktop table has no standalone status header and the current mobile-specific branch still exposes `data-testid="mobile-repayment-row"`; zero-value posted components also remain in the desktop allocation presentation.

- [ ] **Step 3: Add the table imports and shared allocation helper**

In `LoanRepaymentHistory.tsx`:

- Remove `ChevronRight` from the Lucide import but retain `Loader2`.
- Import `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, and `TableRow` from `../../../components/ui/table`.
- Replace `Allocation` and `MobileAllocation` with this exact helper and presentation component:

```tsx
const postedComponentEntries = (item: PaymentIntakeHistoryItem) => item.postedComponents
    ? ([
        ["principal", item.postedComponents.principal],
        ["interest", item.postedComponents.interest],
        ["fee", item.postedComponents.fee],
        ["penalty", item.postedComponents.penalty],
    ] as const).filter(([, amount]) => !new Decimal(amount).isZero())
    : [];

const Allocation = ({ item }: { item: PaymentIntakeHistoryItem }) => {
    const components = postedComponentEntries(item);
    if (components.length > 0) {
        return (
            <div className="flex min-w-64 flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {components.map(([key, amount]) => (
                    <span key={key}>{t(`loanDetail.repaymentHistory.${key}`)} {formatMoneyExact(amount, i18n.language)}</span>
                ))}
            </div>
        );
    }
    return item.latestAllocation
        ? <span className="whitespace-nowrap text-xs text-muted-foreground">{formatMoneyExact(item.latestAllocation.amount, i18n.language)}</span>
        : <span className="text-muted-foreground">—</span>;
};
```

- [ ] **Step 4: Replace both responsive branches with one shadcn table**

Replace the `hidden ... md:block` table and the entire `md:hidden` list with:

```tsx
<Table className="min-w-[64rem]">
    <TableHeader>
        <TableRow className="hover:bg-transparent">
            <TableHead>{t("loanDetail.repaymentHistory.receivedAt")}</TableHead>
            <TableHead className="text-right">{t("loanDetail.repaymentHistory.amount")}</TableHead>
            <TableHead>{t("loanDetail.repaymentHistory.reference")}</TableHead>
            <TableHead>{t("loanDetail.repaymentHistory.allocation")}</TableHead>
            <TableHead>{t("loanDetail.repaymentHistory.statusColumn")}</TableHead>
            <TableHead><span className="sr-only">{t("loanDetail.repaymentHistory.continue")}</span></TableHead>
        </TableRow>
    </TableHeader>
    <TableBody>
        {items.map((item) => (
            <TableRow key={item.publicId}>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatReceivedAt(item.receivedAt)}</TableCell>
                <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">{formatMoneyExact(item.amount, i18n.language)}</TableCell>
                <TableCell className="max-w-56 truncate" title={item.bankReference ?? undefined}>{item.bankReference ?? "—"}</TableCell>
                <TableCell><Allocation item={item} /></TableCell>
                <TableCell className="whitespace-nowrap"><Status status={item.status} /></TableCell>
                <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => openIntake(item.publicId)}>
                        {t("loanDetail.repaymentHistory.continue")}
                    </Button>
                </TableCell>
            </TableRow>
        ))}
    </TableBody>
</Table>
```

- [ ] **Step 5: Add paired status-column translations**

Add these keys under `loanDetail.repaymentHistory` before the nested `status` object:

```json
// frontend/src/locales/en.json
"statusColumn": "Status"
```

```json
// frontend/src/locales/th.json
"statusColumn": "สถานะ"
```

Update the focused test to query `Status` as specified in Step 1. Run the existing locale parity test as part of the focused command.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
cd frontend && bun run test -- tests/loan-repayment-history.vitest.tsx tests/locale-parity.vitest.ts
```

Expected: all Loan Repayment History and locale parity tests pass. The table contains all six headers, non-zero exact allocations, the status badge, and working review navigation; no mobile row remains.

- [ ] **Step 7: Record the UI change before committing**

Under the newest applicable `## vX.Y.Z - YYYY-MM-DD` heading in `CHANGELOG.md`, add or reuse `### Changed` and add:

```markdown
- Unified Loan Detail repayment history into the same compact responsive table style as the repayment schedule, with exact non-zero allocation summaries.
```

Do not stage unrelated changelog edits.

- [ ] **Step 8: Run all frontend verification gates**

Run sequentially:

```bash
cd frontend && bun run test
cd frontend && bun run lint
cd frontend && bun run build
git diff --check
```

Expected: all commands exit zero. The existing Vite chunk-size advisory may remain non-fatal.

- [ ] **Step 9: Inspect and commit only the scoped change**

Inspect `git status --short` and `git diff`. Stage only `LoanRepaymentHistory.tsx`, its focused test, paired locale files, and the exact changelog hunk. Commit with:

```bash
git commit -m "fix: unify repayment history table"
```

Confirm the commit contains no backend, migration, borrower-tag, repayment-schedule, production, or unrelated documentation files.

---

### Task 2: Merge and Frontend-Only Deployment

**Files:**
- No source-file changes expected.

**Interfaces:**
- Consumes: verified branch `codex/loan-repayment-history-table`, target `main`, `.env.production`, and `docker-compose.app.yml`.
- Produces: fast-forward integration and a rebuilt frontend container serving the new table at `http://127.0.0.1:8088/` and the public domain.

- [ ] **Step 1: Return control to the supervising agent**

The tmux worker stops after Task 1 commit. It must not merge, push, deploy, inspect secrets, or operate on the dirty source checkout.

- [ ] **Step 2: Independently verify the commit**

The supervising agent inspects the exact diff and reruns full frontend tests, lint, build, and `git diff --check main...codex/loan-repayment-history-table` from the isolated worktree.

- [ ] **Step 3: Fast-forward merge while preserving dirty files**

Temporarily stash only dirty `CHANGELOG.md` if necessary, run `git merge --ff-only codex/loan-repayment-history-table`, restore that scoped stash, retain both additive entries, and verify:

```bash
git merge-base --is-ancestor codex/loan-repayment-history-table main
```

- [ ] **Step 4: Deploy frontend without dependencies**

From the source checkout run:

```bash
docker compose --env-file .env.production -f docker-compose.app.yml up --build --no-deps -d frontend
```

This `--no-deps` requirement prevents Compose from rebuilding or recreating the dirty backend checkout.

- [ ] **Step 5: Verify production-style deployment**

Verify the frontend service is running, backend `StartedAt` is unchanged, local `http://127.0.0.1:8088/` and public `https://creditsync.beflints.com/` return HTTP 200, and the deployed asset bundle contains `statusColumn` or another unique implementation marker. Do not log in or mutate production data.
