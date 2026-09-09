# Borrower Card Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Borrowers list responsive and privacy-aware by presenting Thai national IDs in a masked, formatted form with an accessible full-value copy action.

**Architecture:** Keep national-ID presentation logic in a pure frontend utility. Extract the visual card from `BorrowerList` into a focused component that owns only card rendering and temporary copy feedback; the list remains responsible for fetching borrowers and opening the edit modal. No API or database changes are required because the raw `idCardNumber` already exists in the borrower DTO.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Lucide React, react-i18next, Vitest, Testing Library.

## Global Constraints

- Preserve raw 13-digit `idCardNumber` in data; format and mask only at the presentation boundary.
- List cards must be `grid-cols-1 md:grid-cols-2`; do not restore a three-column layout.
- Default list presentation must mask the five-digit middle ID group as `X-XXXX-•••••-XX-X`; the copy action copies all 13 raw digits.
- Add every user-visible or accessible string to both `frontend/src/locales/en.json` and `frontend/src/locales/th.json`.
- Do not add a new toast dependency; use a localized, keyboard-accessible status message within the card.
- Keep the existing Edit, Details, photo, tag, phone, credit-score, and map-link behavior intact.
- Update root `CHANGELOG.md` in every commit. Update `README.md` in the integration commit because this changes a user-facing privacy behavior.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `frontend/src/lib/thai-national-id.ts` | Pure normalization, formatting, and masking of a Thai 13-digit national ID. |
| `frontend/tests/thai-national-id.test.ts` | Unit coverage for valid and invalid identity values. |
| `frontend/src/pages/dashboard/borrowers/BorrowerCard.tsx` | Responsive borrower card, identity presentation, clipboard feedback, and existing per-card actions. |
| `frontend/tests/borrower-card.vitest.tsx` | Component coverage for masking, copy behavior, missing-ID state, aliases, actions, and responsive classes. |
| `frontend/src/pages/dashboard/borrowers/BorrowerList.tsx` | Data loading, empty state, edit-modal state, and mapping each list record into `BorrowerCard`. |
| `frontend/src/locales/en.json` | English borrower-card copy and feedback. |
| `frontend/src/locales/th.json` | Thai borrower-card copy and feedback. |
| `README.md` | User-facing note that list-view national IDs are masked and copy is intentional. |
| `CHANGELOG.md` | v0.3.5 implementation entries. |

### Task 1: Create Thai national-ID presentation utilities

**Files:**
- Create: `frontend/src/lib/thai-national-id.ts`
- Test: `frontend/tests/thai-national-id.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `formatThaiNationalId(value: unknown): string | null`.
- Produces `maskThaiNationalId(value: unknown): string | null`.
- Later consumers call both functions with the borrower DTO's `idCardNumber` field and render no copy control when either returns `null`.

- [ ] **Step 1: Write failing utility tests**

```ts
import { describe, expect, test } from "vitest";
import { formatThaiNationalId, maskThaiNationalId } from "../src/lib/thai-national-id";

describe("Thai national-ID presentation", () => {
    test("formats and masks a 13-digit ID without changing its raw value", () => {
        expect(formatThaiNationalId("1234567890123")).toBe("1-2345-67890-12-3");
        expect(maskThaiNationalId("1234567890123")).toBe("1-2345-•••••-12-3");
    });

    test("returns null for absent, non-numeric, or wrong-length values", () => {
        expect(formatThaiNationalId(null)).toBeNull();
        expect(formatThaiNationalId("31605A0322370")).toBeNull();
        expect(maskThaiNationalId("316050032237")).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bun run test tests/thai-national-id.test.ts`  
Expected: FAIL because `thai-national-id` does not yet exist.

- [ ] **Step 3: Write minimal implementation**

```ts
const THAI_ID = /^\d{13}$/u;

export function formatThaiNationalId(value: unknown): string | null {
    const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
    if (!THAI_ID.test(digits)) return null;
    return `${digits[0]}-${digits.slice(1, 5)}-${digits.slice(5, 10)}-${digits.slice(10, 12)}-${digits[12]}`;
}

export function maskThaiNationalId(value: unknown): string | null {
    const formatted = formatThaiNationalId(value);
    return formatted ? `${formatted.slice(0, 7)}•••••${formatted.slice(-5)}` : null;
}
```

- [ ] **Step 4: Run focused and full frontend tests**

Run: `cd frontend && bun run test tests/thai-national-id.test.ts && bun run test`  
Expected: PASS; no existing test regresses.

- [ ] **Step 5: Update changelog and commit**

Add a v0.3.5 `Added` entry stating that Thai-ID formatting/masking utilities were introduced for borrower-list presentation.

```bash
git add frontend/src/lib/thai-national-id.ts frontend/tests/thai-national-id.test.ts CHANGELOG.md
git commit -m "feat: add borrower ID presentation utilities"
```

### Task 2: Build the responsive, accessible borrower card

**Files:**
- Create: `frontend/src/pages/dashboard/borrowers/BorrowerCard.tsx`
- Create: `frontend/tests/borrower-card.vitest.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes `formatThaiNationalId` and `maskThaiNationalId` from `frontend/src/lib/thai-national-id.ts`.
- Produces `BorrowerCard` with props `{ borrower, onEdit }`, where `borrower` includes `id`, `publicId`, `name`, `photoUrl`, `idCardNumber`, `tags`, `phone`, `creditScore`, and `googleMapsUrl`.
- Produces the existing route `/borrowers/${borrower.publicId ?? borrower.id}` and invokes `onEdit(borrower)` without changing list ownership of edit-modal state.

- [ ] **Step 1: Add failing component tests**

```tsx
test("masks the displayed ID and copies only the raw full value", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<MemoryRouter><BorrowerCard borrower={borrower} onEdit={vi.fn()} /></MemoryRouter>);

    expect(screen.getByText("1-2345-•••••-12-3")).toBeInTheDocument();
    expect(screen.queryByText("1-2345-67890-12-3")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /copy id card/i }));
    expect(writeText).toHaveBeenCalledWith("1234567890123");
    expect(await screen.findByRole("status")).toHaveTextContent(/copied/i);
});

test("omits the copy action when an ID is absent or malformed", () => {
    render(<MemoryRouter><BorrowerCard borrower={{ ...borrower, idCardNumber: null }} onEdit={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText(/no id card/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy id card/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bun run test tests/borrower-card.vitest.tsx`  
Expected: FAIL because `BorrowerCard` does not yet exist.

- [ ] **Step 3: Add localized copy strings**

Add these keys under `borrowers` in both locale files:

```json
{
  "copyIdCard": "Copy ID card for {{name}}",
  "idCardCopied": "ID card copied.",
  "idCardCopyFailed": "Unable to copy ID card."
}
```

Use Thai translations in `th.json`, not hard-coded Thai in the component.

- [ ] **Step 4: Implement `BorrowerCard`**

Implement the header with `flex min-w-0 items-start gap-3`, an avatar sized `h-12 w-12 shrink-0`, and a name block using `min-w-0 break-words leading-snug` rather than `truncate`. Render the masked ID using `font-mono tabular-nums` and add an icon-only Lucide `Copy` button with an `aria-label`, `title`, focus-visible ring, and `onClick` handler:

```tsx
const copyIdCard = async () => {
    if (!rawId) return;
    try {
        await navigator.clipboard.writeText(rawId);
        setCopyStatus("success");
    } catch {
        setCopyStatus("error");
    }
};
```

Render localized copy feedback as `role="status" aria-live="polite"`. Preserve tags, contact details, map link, Edit, and Details. Use `flex-wrap` in the footer so action buttons do not overflow on narrow cards.

- [ ] **Step 5: Run focused component tests and lint**

Run: `cd frontend && bun run test tests/borrower-card.vitest.tsx && bun run lint`  
Expected: PASS; tests prove raw ID is copied but not rendered, alias/tag wrapping is retained, and Edit/Details remain available.

- [ ] **Step 6: Update changelog and commit**

Add a v0.3.5 `Added` entry for the responsive, masked borrower identity card and accessible copy feedback.

```bash
git add frontend/src/pages/dashboard/borrowers/BorrowerCard.tsx frontend/tests/borrower-card.vitest.tsx frontend/src/locales/en.json frontend/src/locales/th.json CHANGELOG.md
git commit -m "feat: add responsive borrower identity card"
```

### Task 3: Integrate the card into the borrower list and verify responsive behavior

**Files:**
- Modify: `frontend/src/pages/dashboard/borrowers/BorrowerList.tsx`
- Modify: `frontend/tests/borrower-card.vitest.tsx`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes `BorrowerCard` from `frontend/src/pages/dashboard/borrowers/BorrowerCard.tsx`.
- Keeps `BorrowerList` responsible for `GET /borrowers`, `selectedBorrower`, `editModalOpen`, and passing `handleEdit` to each card.
- Produces a list grid with exactly `grid-cols-1 md:grid-cols-2` and no `lg:grid-cols-3` class.

- [ ] **Step 1: Extend the failing integration test**

```tsx
test("uses a one-column mobile and two-column md borrower grid", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [borrower, secondBorrower] });
    render(<MemoryRouter><BorrowerList /></MemoryRouter>);
    const grid = await screen.findByTestId("borrower-card-grid");
    expect(grid).toHaveClass("grid-cols-1", "md:grid-cols-2");
    expect(grid).not.toHaveClass("lg:grid-cols-3");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bun run test tests/borrower-card.vitest.tsx`  
Expected: FAIL because the list grid has no `data-testid` and still contains `lg:grid-cols-3`.

- [ ] **Step 3: Replace inline cards with `BorrowerCard`**

Remove card-only imports and helper functions from `BorrowerList`. Replace the existing card mapping with:

```tsx
<div data-testid="borrower-card-grid" className="grid grid-cols-1 gap-4 md:grid-cols-2">
    {borrowers.map((borrower) => (
        <BorrowerCard key={borrower.id} borrower={borrower} onEdit={handleEdit} />
    ))}
</div>
```

Do not change the search, empty state, page header, fetch route, edit modal, or Details route behavior.

- [ ] **Step 4: Document the privacy behavior**

Add a concise Borrowers section to `README.md`: list cards mask national IDs by default; the copy action intentionally copies the complete stored value for authorized owner workflows; the detail/edit workflow remains the full-value surface.

- [ ] **Step 5: Run automated verification**

Run: `cd frontend && bun run test && bun run lint && bun run build`  
Expected: PASS. The production build may report the existing bundle-size warning but must not fail.

- [ ] **Step 6: Run visual verification at three widths**

Use the in-app browser on `/borrowers` and capture/inspect each state:

1. A narrow mobile viewport: one card per row, no horizontal overflow, actions wrap if needed.
2. An `md` viewport: exactly two cards per row.
3. A wide desktop viewport: exactly two cards per row, readable name/ID/tag rows, copy icon visible and focusable.

Also verify the Copy button shows localized success feedback and the raw ID is not visible in the list after copying.

- [ ] **Step 7: Update docs and commit**

Add v0.3.5 `Changed`/`Fixed` entries for the two-column responsive list, masked identity presentation, and protected copy action.

```bash
git add frontend/src/pages/dashboard/borrowers/BorrowerList.tsx frontend/tests/borrower-card.vitest.tsx README.md CHANGELOG.md
git commit -m "feat: integrate privacy-aware borrower cards"
```

## Plan Self-Review

- **Spec coverage:** Task 1 covers pure ID formatting/masking; Task 2 covers avatar hierarchy, aliases, accessibility, localized copy feedback, missing-ID behavior, and raw-copy safety; Task 3 covers full-width mobile, two columns from `md`, retained actions, documentation, and three-width visual verification.
- **Placeholder scan:** No incomplete tasks, generic test instructions, or undefined interfaces remain.
- **Type consistency:** Task 1 exports the two exact utility names consumed in Task 2. Task 2 exports `BorrowerCard`, which Task 3 imports. `BorrowerList` continues to own `handleEdit` and only delegates rendering to the card.
