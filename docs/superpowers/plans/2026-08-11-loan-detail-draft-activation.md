# Loan Detail Draft Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator safely activate any persisted loan draft from Loan Detail through a localized confirmation dialog.

**Architecture:** `LoanDetail.tsx` owns the draft-only action, confirmation state, and the existing activation endpoint call. It renders backend-owned loan values, replaces local loan state with the activation response, and never posts a disbursement or recalculates accounting values. A focused Vitest interaction test protects visibility, confirmation, success, and failure behavior.

**Tech Stack:** React 19, React Router, react-i18next, Radix Dialog, Axios API client, Vitest, Testing Library, Bun, TypeScript, Vite.

## Global Constraints

- Activation is explicit and locks active loan terms; the first click must not mutate financial state.
- Actual disbursement posting remains independent and must not be triggered by activation.
- Frontend money display consumes decimal strings and must not perform accounting calculations.
- Add matching keys to `frontend/src/locales/en.json` and `frontend/src/locales/th.json`.
- Every commit updates `CHANGELOG.md` with an explicit project version.

---

### Task 1: Protect the activation interaction with a failing UI test

**Files:**
- Create: `frontend/tests/loan-detail-activation.vitest.tsx`

**Interfaces:**
- Consumes: `LoanDetail` default export and `api.get` / `api.post` from `frontend/src/lib/api.ts`.
- Produces: Interaction coverage requiring a draft-only action, confirmation gate, exact activation endpoint, local active-state refresh, and safe error state.

- [ ] **Step 1: Create the Loan Detail test harness**

Mock only external page dependencies while rendering the real `LoanDetail` and real shared Dialog/Button components. Use an exact loan fixture:

```tsx
const LOAN_ID = "019ff023-fd64-7d41-9aae-723d2a458a8a";
const draftLoan = {
  id: LOAN_ID,
  publicId: LOAN_ID,
  borrowerPublicId: "019fea17-6068-7ccb-b267-9f39880bb762",
  principalAmount: "4000.00",
  interestRate: "0.00",
  repaymentType: "floating",
  termMonths: null,
  installmentAmount: null,
  totalInstallments: null,
  startDate: "2026-08-06",
  nextDueDate: null,
  outstandingPrincipal: "0.00",
  outstandingInterest: "0.00",
  outstandingFees: "0.00",
  status: "draft",
};
```

Stub GET responses by URL for loan, schedule, funding allocations, allocation state, and borrower. Mock admin session as false so profitability is not fetched. Mock `LoanRenewalPanel`, `LoanDisbursements`, and `LoanRepaymentHistory` as inert components because they are not the behavior under test.

- [ ] **Step 2: Add the draft confirmation and success test**

```tsx
test("requires confirmation before activating an existing loan draft", async () => {
  apiPost.mockResolvedValueOnce({ data: { ...draftLoan, status: "active", outstandingPrincipal: "4000.00" } });
  renderLoanDetail();

  const open = await screen.findByRole("button", { name: "เปิดใช้งานสัญญา" });
  await userEvent.click(open);
  expect(apiPost).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toHaveTextContent("฿4,000.00");

  await userEvent.click(screen.getByRole("button", { name: "ยืนยันเปิดใช้งาน" }));
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith(`/loans/${LOAN_ID}/activate`));
  await waitFor(() => expect(screen.queryByRole("button", { name: "เปิดใช้งานสัญญา" })).not.toBeInTheDocument());
  expect(screen.getByText("ACTIVE")).toBeInTheDocument();
});
```

- [ ] **Step 3: Add active visibility and failure tests**

Assert that an initially active fixture never shows the activation action. For a rejected POST, assert the localized activation error appears, the status remains `DRAFT`, and the activation action remains available for retry.

- [ ] **Step 4: Run the focused test and verify RED**

Run:

```bash
cd frontend && bun test ./tests/loan-detail-activation.vitest.tsx
```

Expected: FAIL because Loan Detail has no draft activation action or confirmation dialog.

---

### Task 2: Implement the draft-only confirmation workflow

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `CHANGELOG.md`
- Test: `frontend/tests/loan-detail-activation.vitest.tsx`

**Interfaces:**
- Consumes: `POST /loans/:publicId/activate`, returning the activated `LoanDetailData` payload.
- Produces: A draft-only `Activate loan` action and accessible confirmation dialog that updates `loan` state on success.

- [ ] **Step 1: Add activation state and command handler**

In `LoanDetail`, add:

```tsx
const [activationOpen, setActivationOpen] = useState(false);
const [activating, setActivating] = useState(false);

const activateDraft = async () => {
  if (!loan || loan.status !== "draft" || activating) return;
  try {
    setActivating(true);
    const response = await api.post(`/loans/${loan.publicId}/activate`);
    setLoan(response.data);
    setActivationOpen(false);
    setErrorMessage("");
  } catch (error) {
    console.error("Failed to activate loan draft", error);
    setErrorMessage(t("loanDetail.activation.error"));
  } finally {
    setActivating(false);
  }
};
```

The guard prevents stale or repeated requests. Do not call any disbursement endpoint.

- [ ] **Step 2: Add the draft-only action in the page header**

Import `CheckCircle` and the shared Radix dialog exports. Render the button only for `loan?.status === "draft"` after loading:

```tsx
{!loading && loan?.status === "draft" && (
  <Button onClick={() => setActivationOpen(true)}>
    <CheckCircle className="mr-2 h-4 w-4" />
    {t("loanDetail.activation.action")}
  </Button>
)}
```

Keep it in the header action area so it remains discoverable before the financial cards.

- [ ] **Step 3: Add the accessible confirmation dialog**

Import `formatMoneyExact` from `frontend/src/lib/workflow-model.ts`, change the translation hook to `const { t, i18n } = useTranslation()`, and use `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, and `DialogTitle`. The summary reads `borrower?.name`, `loan.principalAmount`, `loan.repaymentType`, and `loan.startDate`; format money with the existing exact decimal-string formatter rather than `Number`.

```tsx
<Dialog open={activationOpen} onOpenChange={(open) => !activating && setActivationOpen(open)}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>{t("loanDetail.activation.title")}</DialogTitle>
      <DialogDescription>{t("loanDetail.activation.warning")}</DialogDescription>
    </DialogHeader>
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div><dt className="text-muted-foreground">{t("loanDetail.activation.borrower")}</dt><dd className="font-medium">{borrower?.name ?? t("loanDetail.unknownBorrower")}</dd></div>
      <div><dt className="text-muted-foreground">{t("loanDetail.activation.principal")}</dt><dd className="font-medium">{formatMoneyExact(loan?.principalAmount ?? "0.00", i18n.language)}</dd></div>
      <div><dt className="text-muted-foreground">{t("loanDetail.activation.repaymentType")}</dt><dd className="font-medium">{t(`loanWizard.repaymentOptions.${loan?.repaymentType ?? "floating"}`)}</dd></div>
      <div><dt className="text-muted-foreground">{t("loanDetail.activation.startDate")}</dt><dd className="font-medium">{loan?.startDate ?? "-"}</dd></div>
    </dl>
    <DialogFooter>
      <Button variant="outline" disabled={activating} onClick={() => setActivationOpen(false)}>
        {t("common.cancel")}
      </Button>
      <Button disabled={activating} onClick={() => void activateDraft()}>
        {activating ? t("loanDetail.activation.activating") : t("loanDetail.activation.confirm")}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 4: Add paired Thai and English copy**

Under `loanDetail.activation`, add matching keys:

```json
{
  "action": "Activate loan",
  "title": "Activate this loan?",
  "warning": "Activation locks the financial terms and creates any applicable immutable repayment schedule. Disbursements are posted separately.",
  "borrower": "Borrower",
  "principal": "Principal",
  "repaymentType": "Repayment type",
  "startDate": "Start date",
  "confirm": "Confirm activation",
  "activating": "Activating...",
  "error": "Failed to activate the loan. The draft was not changed."
}
```

```json
{
  "action": "เปิดใช้งานสัญญา",
  "title": "เปิดใช้งานสัญญานี้หรือไม่",
  "warning": "การเปิดใช้งานจะล็อกเงื่อนไขทางการเงินและสร้างตารางชำระที่แก้ไขไม่ได้ (ถ้ามี) ส่วนยอดจ่ายเงินจริงต้องลงบัญชีแยกต่างหาก",
  "borrower": "ผู้กู้",
  "principal": "เงินต้น",
  "repaymentType": "ประเภทการชำระ",
  "startDate": "วันที่เริ่ม",
  "confirm": "ยืนยันเปิดใช้งาน",
  "activating": "กำลังเปิดใช้งาน...",
  "error": "เปิดใช้งานสัญญาไม่สำเร็จ ร่างสัญญายังไม่ถูกเปลี่ยนแปลง"
}
```

- [ ] **Step 5: Update the current changelog version**

Add to `CHANGELOG.md` under `v0.3.9` → `Added`:

```markdown
- Added a localized Loan Detail confirmation action for activating persisted drafts without automatically posting disbursements.
```

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```bash
cd frontend && bun test ./tests/loan-detail-activation.vitest.tsx
```

Expected: all activation interaction tests pass.

- [ ] **Step 7: Commit the implementation**

```bash
git add frontend/src/pages/dashboard/loans/LoanDetail.tsx frontend/src/locales/en.json frontend/src/locales/th.json frontend/tests/loan-detail-activation.vitest.tsx CHANGELOG.md
git commit -m "feat: activate loan drafts from detail"
```

---

### Task 3: Verify and deploy the frontend

**Files:**
- Verify: `frontend/`
- Deploy: `docker-compose.app.yml` service `frontend`

**Interfaces:**
- Consumes: completed Loan Detail activation UI and production backend activation route.
- Produces: a built and browser-verified production frontend.

- [ ] **Step 1: Run the full frontend quality gate**

```bash
cd frontend
bun test
bun run lint
bun run build
```

Expected: all commands exit 0 with no test failures, lint errors, or TypeScript/build errors.

- [ ] **Step 2: Rebuild only the production frontend**

```bash
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d frontend
```

Expected: the frontend image builds and `creditsync-frontend-prod` is running.

- [ ] **Step 3: Perform browser QA**

Open a disposable draft loan in the production UI. Verify the action appears, the first click only opens the dialog, cancel does not mutate, confirm changes status to active, repeat submission is disabled, and an active loan does not show the action. Check desktop and mobile widths and confirm no console errors.

- [ ] **Step 4: Record verification evidence**

Capture the exact test/lint/build counts, container status, and browser-observed draft-to-active transition in the task handoff. Do not create test financial records in a live tenant unless an explicitly authorized controlled test tenant is available.
