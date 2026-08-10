# CreditSync Landing and Login Redesign Design

## Purpose

Make the first encounter with CreditSync feel like a trustworthy Thai-first
lending-operations tool, not a generic consumer-fintech marketing site. The
entry experience should clearly answer two questions: what work is visible in
CreditSync, and how an authorized operator gets into it.

## Approved Direction: Calm Operations Overview

The approved visual direction is the first concept: an editorial two-column
landing page on a warm off-white surface, topped by a deep navy header. The
left column establishes the product promise and leads directly to sign-in. The
right column previews an orderly operational view, with only the three work
states that matter at the start of a day.

The existing CreditSync cyan-to-violet identity remains an accent for the logo
and primary actions. It is not used as decorative glow, animated gradient
copy, or a substitute for hierarchy.

## Scope

### Landing page

- Show the CreditSync wordmark and one primary header action: `เข้าสู่ระบบ`.
- Use a concise Thai headline: `จัดการพอร์ตสินเชื่อ ให้เห็นงานสำคัญก่อน`.
- Use supporting copy that names the real workflow: repayments, funding, and
  items needing review.
- Make `เข้าสู่ระบบ` the only primary call to action, in both the header and
  hero. Both controls navigate to `/login`.
- Replace the broken feature/security/pricing anchors and inert documentation
  button. Do not add a documentation CTA until there is a real operator-guide
  destination.
- Display a non-interactive product preview on the right. It contains exactly
  these work rows: `รับชำระวันนี้`, `รายการเกินกำหนด`, and `รอตรวจสลิป`.
  Values and counts are explicitly sample data and must not call the API or
  expose borrower information.
- Include one quiet trust statement: `ข้อมูลแยกตามองค์กรและบันทึกการเปลี่ยนแปลง`.

### Login page

- Reuse the same navy, warm-white, cyan, and violet system so navigation to
  `/login` feels continuous with the landing page.
- Present the CreditSync mark, a Thai title, a one-sentence explanation, and
  the Google sign-in control in a focused, readable panel.
- State that access is for authorized organization accounts only; this is an
  access expectation, not a claim of a new authorization mechanism.
- Replace browser `alert()` failures with an inline, localized error message
  adjacent to the sign-in control. Keep the current Google OAuth API contract
  and redirect behavior unchanged.

## Visual System

| Role | Direction |
| --- | --- |
| Base surfaces | Warm white / blue-gray surface, not full-page black |
| Brand anchor | Deep navy header and login framing |
| Primary action | Saturated accessible blue with restrained cyan/violet detail |
| Separation | Space and thin rules first; borders only where grouping needs them |
| Shape | 10–12 px rounded actions and preview shell; avoid pills except where Google renders its own control |
| Motion | No pulsing ambient lights or scale-on-hover. Respect reduced-motion preferences. |
| Type | Thai-first UI copy, 16 px base body text, concise headings, high contrast |

## Information and Interaction Design

1. A visitor lands on `/` and immediately sees what CreditSync helps them
   prioritize, plus an unambiguous `เข้าสู่ระบบ` action.
2. Selecting either sign-in action opens `/login`; no marketing anchor or
   inactive control remains.
3. The login page presents the existing Google sign-in integration. While a
   request is in progress, the entry state communicates that it is working and
   prevents duplicate intent where the Google component allows it.
4. A failed authentication attempt stays on the page and is announced in an
   inline `role="alert"` message. A successful attempt retains the existing
   token storage and `/dashboard` redirect.

## Localization and Accessibility Requirements

- Add every new visible string to both `frontend/src/locales/th.json` and
  `frontend/src/locales/en.json`; no hardcoded English or Thai copy belongs in
  either flow.
- Keep language selection behavior consistent with the rest of the app.
- Use semantic `header`, `main`, heading, link, and button structure.
- The logo is decorative only when adjacent text supplies the product name;
  otherwise give it meaningful alternative text.
- Maintain a visible keyboard focus ring, 44 px minimum target height for
  primary actions, and clear accessible names for icon-only controls.
- The preview is labelled as an example so assistive technology does not
  mistake it for live portfolio data.

## Technical Boundaries

- Keep routes unchanged: `/` remains the landing page and `/login` remains the
  authentication page.
- Preserve the existing `GoogleOAuthProvider`, auth POST request, token/user
  storage, and dashboard redirect.
- Keep landing sample content local and static; do not introduce dashboard API
  calls or new backend endpoints.
- Preserve the existing shadcn-style `Button`, Tailwind, React Router, and
  i18next patterns rather than adding a new design framework.

## Verification

- Add focused Vitest coverage for landing copy, valid login destinations, and
  the absence of inert anchor controls.
- Add focused login coverage for Thai/English localized inline authentication
  failure feedback and the unchanged successful redirect contract.
- Run `bun run lint`, `bun run test`, and `bun run build` from `frontend/`.
- Manually check landing and login at 320 px, 768 px, and 1440 px widths;
  verify keyboard focus and reduced-motion behavior.

## Out of Scope

- Dashboard, sidebar, settings, and operational workflow redesign.
- New authentication providers, role rules, backend authorization, or account
  recovery.
- A public documentation site or any external marketing/pricing page.
- Changes to borrower, loan, payment, or funding data.
