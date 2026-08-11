# CreditSync Landing and Login Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the disconnected marketing-style entry screens with a Thai-first, trustworthy operations landing page and a coherent Google sign-in experience.

**Architecture:** Keep `/` and `/login` as their existing React Router routes. `LandingPage` remains static and renders a labelled sample operations preview; it does not fetch portfolio data. `Login` retains the existing Google OAuth POST, storage, and dashboard redirect while adding localized UI state for authentication failures.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, React Router, react-i18next, @react-oauth/google, Vitest, Testing Library, Bun.

## Global Constraints

- Do not modify backend authentication, authorization, token storage keys, API endpoints, or protected routes.
- Keep `/` as the landing route and `/login` as the Google-authentication route.
- Add or change visible copy in `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together; format no user-facing text with hardcoded language strings.
- Use existing shadcn-style `Button`, Tailwind utilities, and Lucide icons already in `frontend/package.json`; do not add a design framework or image assets.
- Landing preview data is static example content, labelled as an example, and must not contain real borrower data or API calls.
- Preserve keyboard-visible focus, semantic landmarks, and a 44 px minimum height for the primary sign-in actions.
- Every implementation commit must update `CHANGELOG.md` with an explicit project version. Do not stage unrelated modifications.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `frontend/src/pages/LandingPage.tsx` | Static, localized landing composition and sample operations preview. |
| `frontend/src/pages/auth/Login.tsx` | Localized Google sign-in surface and inline failure state while retaining auth behavior. |
| `frontend/src/locales/en.json` | English `landing` strings and expanded `login` strings. |
| `frontend/src/locales/th.json` | Thai equivalents for every new entry-experience string. |
| `frontend/tests/entry-experience.vitest.tsx` | Route, localization, accessibility, and auth-error regression coverage. |
| `CHANGELOG.md` | Versioned user-facing change summary for the implementation commit. |

## Task 1: Establish Entry-Experience Tests and Translation Contract

**Files:**
- Create: `frontend/tests/entry-experience.vitest.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`

**Interfaces:**
- Consumes: `LandingPage`, `Login`, the shared initialized i18n instance from `tests/setup.ts`, and `api.post`.
- Produces: the `landing.*` and expanded `login.*` translation contracts used by both entry screens; tests that fail until Tasks 2 and 3 render those contracts.

- [ ] **Step 1: Add the English and Thai translation contract**

Add matching top-level objects. Keep the keys identical in both locale files:

```json
"landing": {
  "eyebrow": "Operations overview",
  "title": "Manage your lending portfolio with the important work in view first",
  "description": "Track repayments, funding, and items that need review in one place.",
  "signIn": "Sign in",
  "previewLabel": "Example of today’s operations overview",
  "todayPayments": "Payments due today",
  "overdueItems": "Overdue items",
  "slipsToReview": "Payment slips to review",
  "trust": "Organization-separated data with recorded changes"
},
"login": {
  "title": "Sign in to CreditSync",
  "description": "Use your authorized organization account to manage your lending portfolio.",
  "continue_google": "Continue with Google",
  "authorizedOnly": "For authorized organization accounts only.",
  "failed": "We could not sign you in. Please try again.",
  "failedWithReason": "We could not sign you in: {{reason}}"
}
```

Use Thai translations with the same meaning, including `เข้าสู่ระบบ`, `ข้อมูลตัวอย่างภาพรวมงานวันนี้`, `รับชำระวันนี้`, `รายการเกินกำหนด`, `รอตรวจสลิป`, and `สำหรับบัญชีที่ได้รับอนุญาตในองค์กรเท่านั้น`.

- [ ] **Step 2: Write focused failing component tests**

Create `frontend/tests/entry-experience.vitest.tsx`. Mock Google Login as an accessible button so the login callback can be exercised without external OAuth:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import i18n from "../src/lib/i18n";
import { api } from "../src/lib/api";
import LandingPage from "../src/pages/LandingPage";
import Login from "../src/pages/auth/Login";

vi.mock("../src/lib/api", () => ({ api: { post: vi.fn() } }));
vi.mock("@react-oauth/google", () => ({
  GoogleLogin: ({ onError }: { onError: () => void }) => (
    <button type="button" onClick={onError}>Continue with Google</button>
  ),
}));

beforeEach(async () => {
  localStorage.clear();
  vi.clearAllMocks();
  await i18n.changeLanguage("th");
});

test("landing sends both sign-in actions to the login route and labels its preview as example data", () => {
  render(<MemoryRouter><LandingPage /></MemoryRouter>);
  const signInLinks = screen.getAllByRole("link", { name: /เข้าสู่ระบบ/i });
  expect(signInLinks).toHaveLength(2);
  for (const link of signInLinks) {
    expect(link).toHaveAttribute("href", "/login");
  }
  expect(screen.getByText(/ข้อมูลตัวอย่างภาพรวมงานวันนี้/i)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /pricing|features|security/i })).not.toBeInTheDocument();
});

test("login announces a Google sign-in error inline instead of opening an alert", async () => {
  const user = userEvent.setup();
  const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
  render(<Login />);
  await user.click(screen.getByRole("button", { name: /continue with google/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/ไม่สามารถเข้าสู่ระบบ/i);
  expect(alertSpy).not.toHaveBeenCalled();
  expect(vi.mocked(api.post)).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the new test file and confirm it fails before UI work**

Run: `bun run test -- tests/entry-experience.vitest.tsx`

Expected: FAIL because the existing landing has hardcoded English actions and no example-preview label, and the existing login uses browser alerts instead of `role="alert"`.

- [ ] **Step 4: Validate locale JSON syntax before proceeding**

Run: `bun -e 'JSON.parse(await Bun.file("src/locales/en.json").text()); JSON.parse(await Bun.file("src/locales/th.json").text())'`

Expected: exit code 0.

## Task 2: Rebuild the Static Landing Entry Point

**Files:**
- Modify: `frontend/src/pages/LandingPage.tsx`
- Test: `frontend/tests/entry-experience.vitest.tsx`

**Interfaces:**
- Consumes: `useTranslation` from `react-i18next`, `Link` from React Router, `Button`, and Lucide `ArrowRight`, `ShieldCheck`, `WalletCards`, and `FileSearch` icons.
- Produces: a responsive semantic landing page with two `/login` links and an example-only operations preview.

- [ ] **Step 1: Replace hardcoded landing text with translation lookups**

Start the component with:

```tsx
import { useTranslation } from "react-i18next";

const previewRows = [
  { key: "todayPayments", count: "12", amount: "฿245,600", icon: WalletCards, tone: "text-blue-700 bg-blue-50" },
  { key: "overdueItems", count: "4", amount: "฿88,750", icon: ShieldCheck, tone: "text-rose-700 bg-rose-50" },
  { key: "slipsToReview", count: "7", amount: "฿126,900", icon: FileSearch, tone: "text-violet-700 bg-violet-50" },
] as const;

export default function LandingPage() {
  const { t } = useTranslation();
```

Render text exclusively through `t("landing.…")`. The labels and values remain deterministic static sample content; do not import `api` or dashboard modules.

- [ ] **Step 2: Implement the approved responsive information structure**

Use one `header` and one `main`. The header contains the existing brand name and a `Link`/`Button` to `/login`. The main changes from one column on small screens to an approximately 42/58 two-column grid at `lg`:

```tsx
<main className="mx-auto grid max-w-7xl gap-12 px-6 py-14 lg:min-h-[calc(100vh-5rem)] lg:grid-cols-[minmax(0,0.85fr)_minmax(34rem,1.15fr)] lg:items-center lg:px-10">
  <section aria-labelledby="landing-title" className="max-w-xl">
    <p className="mb-4 text-sm font-semibold text-blue-700">{t("landing.eyebrow")}</p>
    <h1 id="landing-title" className="text-4xl font-bold tracking-tight text-slate-950 sm:text-5xl">
      {t("landing.title")}
    </h1>
    <p className="mt-6 text-base leading-7 text-slate-600 sm:text-lg">{t("landing.description")}</p>
    <Link to="/login" className="mt-8 inline-flex">
      <Button size="lg" className="min-h-11 bg-blue-700 px-6 hover:bg-blue-800">
        {t("landing.signIn")} <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
      </Button>
    </Link>
    <p className="mt-10 flex items-center gap-2 text-sm text-slate-600"><ShieldCheck className="h-5 w-5 text-slate-800" aria-hidden="true" />{t("landing.trust")}</p>
  </section>
  <section aria-labelledby="operations-preview-title" className="rounded-xl border border-slate-200 bg-white shadow-sm">
    {/* labelled example preview */}
  </section>
</main>
```

Inside the preview, render a heading with `id="operations-preview-title"`, the `landing.previewLabel` text, and a `ul` whose three `li` entries are generated from `previewRows`. Each row exposes label, count, amount, and an `aria-hidden` icon. Do not make preview rows buttons or links.

- [ ] **Step 3: Remove deceptive or inactive landing controls and motion**

Delete the `#features`, `#safety`, and `#pricing` links, the inert documentation button, ambient pulsing lights, hover-scale calls to action, and feature-card grid. Keep the page background light and the header deep navy; use cyan/violet only as small accent treatments.

- [ ] **Step 4: Run the focused landing tests**

Run: `bun run test -- tests/entry-experience.vitest.tsx`

Expected: the landing assertions pass; the login error assertion remains failing until Task 3.

## Task 3: Align Login With the Landing and Add Recoverable Error Feedback

**Files:**
- Modify: `frontend/src/pages/auth/Login.tsx`
- Test: `frontend/tests/entry-experience.vitest.tsx`

**Interfaces:**
- Consumes: `useState`, `useEffect`, `useTranslation`, `GoogleLogin`, and `api.post("/auth/google", { idToken })`.
- Produces: the same successful token/user persistence and `/dashboard` redirect, plus localized inline failure feedback.

- [ ] **Step 1: Add local error state and translation access**

At the top of `Login`, add:

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ShieldCheck } from "lucide-react";

const [errorMessage, setErrorMessage] = useState("");
const { t } = useTranslation();
```

Retain the existing token check in `useEffect`; it must still redirect stored sessions to `/dashboard`.

- [ ] **Step 2: Build the focused, localized sign-in surface**

Replace the dark animated glass card with a warm-white page, deep-navy header/brand anchor, and a centered sign-in panel. The panel must contain an `h1` with `t("login.title")`, a description with `t("login.description")`, the existing `GoogleLogin` component, and this authorization note:

```tsx
<p className="mt-5 flex items-start gap-2 text-sm leading-6 text-slate-600">
  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-700" aria-hidden="true" />
  {t("login.authorizedOnly")}
</p>
```

Keep a minimum 44 px visual target around the OAuth component. Do not try to restyle Google-owned button internals.

- [ ] **Step 3: Replace alerts with an announced inline failure state**

In both `onError` and the `catch` block, call `setErrorMessage(...)` instead of `alert(...)`. Use server-provided safe error detail when available, otherwise `t("login.failed")`. Render the error directly below Google Login:

```tsx
{errorMessage && (
  <div role="alert" className="mt-4 flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
    <span>{errorMessage}</span>
  </div>
)}
```

Clear the previous error at the beginning of the successful Google callback. Preserve `localStorage.setItem("token", res.data.accessToken)`, `localStorage.setItem("user", JSON.stringify(res.data.user))`, and `window.location.href = "/dashboard"` exactly.

- [ ] **Step 4: Make the test simulate the actual mocked Google error label**

Update the mocked Google button in Task 1 to use `t("login.continue_google")` in the component only; the mock itself may retain the accessible English label. Assert the final alert against `i18n.t("login.failed")` rather than a hardcoded Thai fragment:

```tsx
expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("login.failed"));
```

- [ ] **Step 5: Run the complete focused test file**

Run: `bun run test -- tests/entry-experience.vitest.tsx`

Expected: PASS with both landing and inline error cases green.

## Task 4: Verify Entry Screens and Record the Release

**Files:**
- Modify: `CHANGELOG.md`
- Modify: only files from Tasks 1–3 after review of `git status --short`

**Interfaces:**
- Consumes: completed landing/login implementation and frontend test suite.
- Produces: verified source and a versioned, narrowly staged implementation commit.

- [ ] **Step 1: Add the implementation changelog entry**

Insert a new release section above `v0.3.6`, using the next project version at implementation time. If `v0.3.6` remains the latest release, use this exact entry:

```markdown
## v0.3.7 - 2026-08-10

### Changed
- Redesigned the Thai-first landing and Google sign-in entry screens around a calm operations overview, valid sign-in actions, localized copy, and recoverable inline authentication feedback.
```

If a later commit has already advanced the version, replace only `v0.3.7` with the next sequential project version and retain the summary text.

- [ ] **Step 2: Run quality gates**

Run in `frontend/`:

```bash
bun run lint
bun run test
bun run build
```

Expected: all commands exit 0. The production build may report existing bundle-size advice, but must not report TypeScript, missing asset, or broken import errors.

- [ ] **Step 3: Perform manual responsive and keyboard checks**

Run the frontend and inspect `/` and `/login` at 320 px, 768 px, and 1440 px. At each width verify:

```text
- Landing text and primary action are visible without horizontal scroll.
- The static preview is labelled as example content and stacks beneath the hero on narrow screens.
- Both landing sign-in actions go to /login.
- The Google control, login panel, and inline error have visible focus and readable contrast.
- Reduced-motion mode has no pulse or scale animation essential to reading or completing sign-in.
```

- [ ] **Step 4: Stage only the planned files and commit**

Run:

```bash
git status --short
git add CHANGELOG.md frontend/src/pages/LandingPage.tsx frontend/src/pages/auth/Login.tsx frontend/src/locales/en.json frontend/src/locales/th.json frontend/tests/entry-experience.vitest.tsx
git diff --cached --check
git commit -m "feat: redesign landing and login entry"
```

Expected: only the listed files are staged. Stop and ask before staging if `git status --short` shows another file that overlaps the planned files unexpectedly.

## Plan Self-Review

- Spec coverage: Task 1 localizes every new entry string; Task 2 implements the static operations overview and removes broken/inert controls; Task 3 preserves OAuth behavior while adding recoverable feedback; Task 4 covers accessibility, responsive checks, quality gates, and release documentation.
- Placeholder scan: no unresolved design, code, test, error, or verification requirement remains.
- Type consistency: the only introduced UI state is `errorMessage: string`; `GoogleLogin` continues to receive callbacks, `api.post` continues to receive the existing ID-token payload, and translation keys are referenced identically across tests and components.
