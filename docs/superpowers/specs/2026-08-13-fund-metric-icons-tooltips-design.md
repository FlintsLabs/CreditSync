# Fund Metric Icons and Tooltips Design

## Goal

Make the funding-source summary easier to scan and understand by adding a semantic icon before every metric label and an accessible information control after the label that explains the metric and its short calculation.

## Scope

Apply the pattern to metric rows in:

- settlement position;
- source profitability; and
- contract-to-ledger reconciliation.

Keep the available-capital hero and loan-allocation list unchanged. This avoids visual noise in the detailed contract rows and preserves their existing borrower-first hierarchy.

## Presentation

Each metric label uses one compact inline group:

1. a 16px muted semantic icon;
2. the localized metric label; and
3. a 16px information button with a minimum 32px interactive target.

The semantic icon is decorative and hidden from assistive technology. The information icon is a real button with a localized accessible label. Values retain their existing right alignment, exact decimal formatting, tabular numerals, and semantic colors. Icons do not encode positive or negative status by color alone.

Use these Lucide icons:

| Metric | Icon | Meaning |
| --- | --- | --- |
| Realized spread | `TrendingUp` | Revenue already recognized after source costs |
| Unrealized spread | `Clock3` | Expected revenue not yet collected |
| Net cash received | `WalletCards` | Borrower cash collected after source cash costs |
| Net cash paid | `CircleMinus` | Source cash costs exceeding borrower cash collected |
| Borrower cash collected | `HandCoins` | Principal and revenue cash received from borrowers |
| Fund cost paid | `ReceiptText` | Cash source costs already paid |
| Deployed principal | `ArrowUpRight` | Principal allocated from this source to loans |
| Net cash position | `Landmark` | Borrower cash received less source cash costs |
| Realized ROI | `Percent` | Realized spread divided by deployed principal |
| Opportunity cost | `Timer` | Non-cash cost of tying up own capital |
| Economic spread | `Scale` | Realized spread less opportunity cost |
| Contract-attributed revenue | `FileCheck2` | Revenue attributed from borrower contracts |
| Ledger-recorded revenue | `BookOpenCheck` | Revenue recorded in the append-only source ledger |
| Reconciliation difference | `TriangleAlert` | Contract-attributed revenue less ledger-recorded revenue |

## Tooltip Behavior

Use the existing Radix-compatible tooltip component if present; otherwise add a small shared UI tooltip wrapper following the project's existing UI primitives.

- Desktop: opens on hover and keyboard focus.
- Touch: opens on tap and closes on outside interaction or Escape.
- Content: localized plain-language definition followed by a concise formula where useful.
- Width: capped near 320px, wraps naturally, and remains within the viewport.
- Delay: short enough for deliberate inspection without flashing during normal pointer movement.
- No metric value or sensitive record detail is repeated inside the tooltip.

## Copy Rules

Add matching keys to both `frontend/src/locales/th.json` and `frontend/src/locales/en.json`. Thai labels should replace the ambiguous settlement terms:

- `ยอดส่วนเกิน` becomes `เงินสดรับสุทธิสะสม`;
- `ยอดขาด` becomes `เงินสดจ่ายสุทธิสะสม`.

English uses `Cumulative net cash received` and `Cumulative net cash paid`. Tooltip text must distinguish cash collected from revenue: borrower cash includes returned principal, while realized spread and ROI concern revenue after source costs.

## Component Boundary

Extract a focused `FundMetricLabel` component near the Fund Detail feature. It accepts:

```ts
interface FundMetricLabelProps {
    icon: LucideIcon;
    label: string;
    description: string;
}
```

The component owns decorative-icon treatment, the information button, tooltip layout, and accessibility. `FundDetail` continues to own metric selection, calculations received from the backend, value formatting, and semantic value colors.

## Testing

Extend `frontend/tests/fund-detail.vitest.tsx` test-first to verify:

- every scoped metric exposes a localized information button;
- focusing or interacting with a representative information button reveals the definition;
- semantic icons are decorative and do not create duplicate accessible names;
- exact monetary values and reconciliation status remain unchanged; and
- Thai and English locale files contain matching tooltip keys.

Run the focused test red then green, followed by the full frontend test suite, lint, and production build. Deployment must use a clean committed worktree and verify the public frontend plus the read-only profitability endpoint.

## Non-Goals

- No backend calculation or financial-record changes.
- No icons in every loan-allocation property.
- No new color system or animation.
- No tooltip containing borrower identities, transaction references, or evidence.
