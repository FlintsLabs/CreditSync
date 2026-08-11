# Transaction Amount Color Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render positive transaction totals in green, negative totals in red, and zero totals in the default text color.

**Architecture:** Keep the behavior local to the transaction-list presentation. Add `decimal.js` as a direct frontend dependency, expose a small pure `transactionAmountTone` sign classifier beside the list component, and use it when rendering the total cell; verify the three sign branches through the real rendered component.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS, decimal.js 10.6, Vitest, Testing Library, Bun

## Global Constraints

- Public money remains a decimal string and sign classification must not use JavaScript `Number` or floating point.
- Positive totals use `text-green-600`, negative totals use `text-red-600`, and zero totals receive neither semantic color class.
- The visible minus sign remains present as a non-color cue.
- Do not change component-column colors or transaction behavior.
- Use Bun for dependency management and verification.

---

### Task 1: Semantic transaction-total colors

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/bun.lock`
- Modify: `frontend/src/pages/dashboard/transactions/TransactionList.tsx`
- Create: `frontend/tests/transaction-list.vitest.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: transaction `amount` as a public decimal string from `GET /transactions`.
- Produces: `transactionAmountTone(amount: string): "text-green-600" | "text-red-600" | ""` and a total cell whose class reflects the exact sign.

- [ ] **Step 1: Add the direct exact-decimal dependency**

Run:

```bash
cd frontend && bun add decimal.js@^10.6.0
```

Expected: `frontend/package.json` lists `decimal.js` under `dependencies` and `frontend/bun.lock` remains synchronized.

- [ ] **Step 2: Write the failing rendered-component test**

Create `frontend/tests/transaction-list.vitest.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/lib/api";
import TransactionList from "../src/pages/dashboard/transactions/TransactionList";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn() } }));

describe("TransactionList", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockResolvedValue({ data: [
            { id: "positive", date: "2026-08-12", borrowerName: "Positive borrower", amount: "60.00" },
            { id: "negative", date: "2026-08-12", borrowerName: "Negative borrower", amount: "-60.00" },
            { id: "zero", date: "2026-08-12", borrowerName: "Zero borrower", amount: "0.00" },
        ] });
    });

    test("uses semantic colors for positive, negative, and zero transaction totals", async () => {
        render(<MemoryRouter><TransactionList /></MemoryRouter>);

        const positive = await screen.findByTestId("transaction-total-positive");
        const negative = screen.getByTestId("transaction-total-negative");
        const zero = screen.getByTestId("transaction-total-zero");

        expect(positive).toHaveClass("text-green-600");
        expect(negative).toHaveClass("text-red-600");
        expect(negative).toHaveTextContent("-");
        expect(zero).not.toHaveClass("text-green-600");
        expect(zero).not.toHaveClass("text-red-600");
    });
});
```

This test catches the current wrong branch: a negative or zero total receiving the hard-coded green class.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
cd frontend && bun test tests/transaction-list.vitest.tsx
```

Expected: FAIL because the total cells do not yet expose the test IDs and all totals currently receive `text-green-600`.

- [ ] **Step 4: Implement the minimal exact sign classifier and apply it**

In `TransactionList.tsx`, import Decimal and add:

```tsx
import Decimal from "decimal.js";

export function transactionAmountTone(amount: string): "text-green-600" | "text-red-600" | "" {
    const value = new Decimal(amount);
    if (value.isNegative() && !value.isZero()) return "text-red-600";
    if (value.isPositive() && !value.isZero()) return "text-green-600";
    return "";
}
```

Replace the hard-coded total cell with:

```tsx
<td
    data-testid={`transaction-total-${tx.id}`}
    className={`p-4 font-semibold ${transactionAmountTone(String(tx.amount))}`.trim()}
>
    ฿{Number(tx.amount).toLocaleString(i18n.language)}
</td>
```

This preserves the existing visible amount presentation while changing only semantic color classification.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
cd frontend && bun test tests/transaction-list.vitest.tsx
```

Expected: PASS with positive green, negative red with a visible minus sign, and zero neutral.

- [ ] **Step 6: Update the release changelog**

Under `## v0.3.10 - 2026-08-12` → `### Fixed`, add:

```markdown
- Colored negative transaction totals red and zero totals neutrally while retaining green for positive totals and preserving the visible amount sign.
```

- [ ] **Step 7: Run frontend verification**

Run:

```bash
cd frontend && bun test tests/transaction-list.vitest.tsx && bun run lint && bun run build
```

Expected: all commands exit 0 with no TypeScript, lint, test, or build failures.

- [ ] **Step 8: Review and commit the implementation**

Run:

```bash
git diff --check
git diff -- frontend/package.json frontend/bun.lock frontend/src/pages/dashboard/transactions/TransactionList.tsx frontend/tests/transaction-list.vitest.tsx CHANGELOG.md
git add frontend/package.json frontend/bun.lock frontend/src/pages/dashboard/transactions/TransactionList.tsx frontend/tests/transaction-list.vitest.tsx CHANGELOG.md
git commit -m "fix: color negative transaction totals"
```

Expected: the staged diff contains only the dependency declaration, semantic color behavior, regression test, and matching changelog entry.
