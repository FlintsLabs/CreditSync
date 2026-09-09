# Loan Detail Borrower Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display up to three existing borrower tags, plus an overflow count, in the Loan Detail borrower summary card.

**Architecture:** Reuse the `tags` array already returned by the existing borrower endpoint. Extend the local presentation type and render compact secondary badges inside `LoanDetail`; keep tag storage, APIs, ordering, editing, and all financial behavior unchanged.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4, react-i18next, Vitest, Testing Library, Bun.

## Global Constraints

- Reuse the existing `GET /borrowers/:id` response; do not add or change API calls.
- Preserve API tag order and show only `borrower.tags.slice(0, 3)`.
- If more than three tags exist, show `+${borrower.tags.length - 3}`; do not render the hidden tags.
- If tags are missing, null, or empty, render no tag container or placeholder.
- Do not modify backend, database, MCP, plugin, borrower editing, or financial behavior.
- Keep unrelated working-tree changes unstaged and out of the commit.
- Before committing, update `CHANGELOG.md` under the newest applicable version/date and change-type heading.

---

### Task 1: Borrower Tags in Loan Detail

**Files:**
- Create: `frontend/tests/loan-detail-borrower-tags.vitest.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx:63`
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx:580`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the existing borrower response shape, `BorrowerData`, `Badge`, and `borrower.tags` in source order.
- Produces: a conditional `data-testid="loan-borrower-tags"` presentation row containing at most three secondary badges and an optional `+N` overflow indicator.

- [ ] **Step 1: Write focused failing component tests**

Create `frontend/tests/loan-detail-borrower-tags.vitest.tsx` using the same `MemoryRouter`, mocked `api`, session mock, and child-panel mocks as `frontend/tests/loan-detail-schedule.vitest.tsx`.

Use an active monthly loan with an empty schedule and make the borrower response configurable:

```tsx
function renderLoanDetail(tags: string[] | null) {
    vi.mocked(api.get).mockImplementation(async (url) => {
        if (url === `/loans/${LOAN_ID}`) return { data: loan };
        if (url === `/borrowers/${BORROWER_ID}`) {
            return { data: { id: BORROWER_ID, publicId: BORROWER_ID, name: "ภัทรภร วงษ์สุวรรณ", phone: "0812345678", tags } };
        }
        if (url.endsWith("/schedule") || url.endsWith("/funding-allocations")) return { data: [] };
        if (url.endsWith("/allocation-state")) {
            return { data: { principalAmount: "47000.00", netAllocatedPrincipal: "0.00", remainingGap: "47000.00", overfundedAmount: "0.00", state: "unfunded" } };
        }
        throw new Error(`Unexpected GET ${url}`);
    });

    return render(
        <MemoryRouter initialEntries={[`/loans/${LOAN_ID}`]}>
            <Routes><Route path="/loans/:id" element={<LoanDetail />} /></Routes>
        </MemoryRouter>,
    );
}
```

Add these two tests:

```tsx
it("shows the first three borrower tags and the hidden count", async () => {
    renderLoanDetail(["VIP", "Facebook", "แนะนำต่อ", "ติดตามพิเศษ"]);

    const tags = await screen.findByTestId("loan-borrower-tags");
    expect(within(tags).getByText("VIP")).toBeInTheDocument();
    expect(within(tags).getByText("Facebook")).toBeInTheDocument();
    expect(within(tags).getByText("แนะนำต่อ")).toBeInTheDocument();
    expect(within(tags).getByText("+1")).toBeInTheDocument();
    expect(within(tags).queryByText("ติดตามพิเศษ")).not.toBeInTheDocument();
});

it("omits the tag row when the borrower has no tags", async () => {
    renderLoanDetail(null);

    await screen.findByText("ภัทรภร วงษ์สุวรรณ");
    expect(screen.queryByTestId("loan-borrower-tags")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd frontend && bun run test -- tests/loan-detail-borrower-tags.vitest.tsx
```

Expected: the tag-display test fails because `BorrowerData` and the borrower card do not yet consume or render `tags`; the null-tags test may already pass.

- [ ] **Step 3: Extend the borrower presentation type**

Add the optional response field to `BorrowerData` in `LoanDetail.tsx`:

```tsx
interface BorrowerData {
    id: string;
    publicId?: string;
    name: string;
    phone?: string | null;
    tags?: string[] | null;
}
```

- [ ] **Step 4: Render the compact tag row**

Inside the borrower `CardContent`, immediately after the name row and before the phone, add:

```tsx
{borrower?.tags && borrower.tags.length > 0 && (
    <div data-testid="loan-borrower-tags" className="flex flex-wrap gap-1">
        {borrower.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="secondary" className="h-5 px-1.5 py-0 text-[10px]">
                {tag}
            </Badge>
        ))}
        {borrower.tags.length > 3 && (
            <span className="self-center text-[10px] text-muted-foreground">+{borrower.tags.length - 3}</span>
        )}
    </div>
)}
```

Do not add visible labels, translation keys, tooltips, sorting, editing controls, or a second borrower request.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
cd frontend && bun run test -- tests/loan-detail-borrower-tags.vitest.tsx
```

Expected: both focused tests pass; the first three tags and `+1` are visible, the fourth tag is absent, and null tags produce no tag container.

- [ ] **Step 6: Record the UI change before committing**

Under the newest applicable `## vX.Y.Z - YYYY-MM-DD` heading in `CHANGELOG.md`, add or reuse `### Changed` and add:

```markdown
- Surfaced up to three borrower tags with an overflow count in the Loan Detail borrower summary.
```

Do not stage unrelated changelog edits from other work.

- [ ] **Step 7: Run all frontend verification gates**

Run sequentially:

```bash
cd frontend && bun run test
cd frontend && bun run lint
cd frontend && bun run build
git diff --check
```

Expected: all commands exit zero. An existing non-fatal Vite chunk-size advisory may remain.

- [ ] **Step 8: Inspect and commit only the scoped change**

Inspect `git status --short` and `git diff`. Stage only `LoanDetail.tsx`, the focused test, and the exact changelog hunk for this feature. Commit with:

```bash
git commit -m "feat: show borrower tags on loan detail"
```

Confirm the commit contains no backend, migration, identity-card, repayment-table, deployment, or unrelated documentation files.

---

### Task 2: Merge and Production-Style Frontend Deployment

**Files:**
- No source-file changes expected.

**Interfaces:**
- Consumes: verified feature commit on `codex/loan-detail-borrower-tags`, target branch `main`, root `.env.production`, `docker-compose.app.yml`, and the existing external `creditsync_runtime` network.
- Produces: feature commit integrated into `main` and a rebuilt running `frontend` service available at `http://127.0.0.1:8088/`.

- [ ] **Step 1: Hand control back to the supervising agent**

The tmux worker must stop after committing Task 1. It must not merge, push, deploy, inspect production secrets, or operate on the dirty source checkout. Report the commit SHA and verification evidence to the supervising agent.

- [ ] **Step 2: Independently verify the feature commit**

From the isolated worktree, the supervising agent inspects the exact commit diff and reruns:

```bash
cd frontend && bun run test
cd frontend && bun run lint
cd frontend && bun run build
git diff --check main...codex/loan-detail-borrower-tags
```

Expected: 0 test failures, 0 lint errors, a successful build, and no whitespace errors or out-of-scope files.

- [ ] **Step 3: Merge while preserving source-checkout changes**

If a dirty `CHANGELOG.md` would be overwritten, stash only that file with a descriptive message, run:

```bash
git merge --ff-only codex/loan-detail-borrower-tags
```

Then immediately restore the scoped stash and resolve any additive changelog overlap by retaining both entries. Do not stage or alter other dirty files.

Verify integration:

```bash
git merge-base --is-ancestor codex/loan-detail-borrower-tags main
```

Expected: exit zero and `main` points at the verified feature commit.

- [ ] **Step 4: Rebuild and deploy only the frontend service**

From the repository root run:

```bash
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d frontend
```

Expected: Compose builds the frontend image, recreates the frontend container, and exits zero without rebuilding or restarting the backend intentionally.

- [ ] **Step 5: Verify the deployed frontend**

Run:

```bash
docker compose --env-file .env.production -f docker-compose.app.yml ps frontend
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:8088/ > /dev/null
```

Expected: the frontend service is running and the public endpoint returns a successful HTTP response. Do not log in, create records, or mutate production data.
