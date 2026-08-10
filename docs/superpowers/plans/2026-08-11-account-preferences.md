# Account and Preferences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Profile and Settings dead ends with one protected, localized `/settings` page for read-only account identity, immediate language and appearance preferences, and safe sign-out.

**Architecture:** `AccountPreferencesPage` composes three accessible sections and consumes the existing stored-user, i18next, and theme-provider state. Small shared helpers own account destinations and logout so the desktop/mobile navigation, account menu, and page cannot drift; the existing providers remain the only persistence mechanisms.

**Tech Stack:** React 19, TypeScript 6, React Router 7, react-i18next/i18next, Tailwind CSS, Radix UI primitives, Vitest, Testing Library, Bun.

## Global Constraints

- Profile name, email, avatar, and tenant role are read-only; do not render edit or disabled-input affordances.
- Support localized role labels for `owner`, `manager`, `collector`, and `viewer`, with neutral fallbacks for missing identity data.
- Language choices are exactly Thai and English; appearance choices are exactly Light, Dark, and System.
- Preference changes apply immediately with no Save button and retain the existing i18next/theme persistence ownership.
- Sign-out removes only `token` and `user`, then navigates to `/login`.
- Add no backend endpoint, financial write, audit event, tenant mutation, password, MFA, session inventory, account deletion, or Google-account management.
- Add visible copy to `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together.
- Use Bun for installation, tests, lint, and builds.
- Every implementation commit must update `CHANGELOG.md` with an explicit project version; this user-facing workflow also requires `README.md` in the same release commit.

---

## File Map

- Create `frontend/src/lib/account.ts`: canonical settings paths and the shared storage-cleanup/navigation function.
- Create `frontend/src/pages/dashboard/settings/AccountPreferencesPage.tsx`: page composition, read-only identity, preference controls, live feedback, hash focus, and session action.
- Create `frontend/tests/account-preferences.vitest.tsx`: page behavior, fallbacks, preferences, focus, and sign-out tests.
- Create `frontend/tests/account-navigation.vitest.tsx`: account-menu and dashboard-navigation destination tests.
- Modify `frontend/src/components/theme-provider.tsx`: export the theme type and keep in-memory selection usable when persistence throws.
- Modify `frontend/src/components/AppBar.tsx`: consume shared destinations/sign-out and make account actions functional.
- Modify `frontend/src/layouts/DashboardLayout.tsx`: point Settings at `/settings` and expose a localized mobile-menu name.
- Modify `frontend/src/App.tsx`: register `/settings` and redirect legacy `/dashboard/settings`.
- Modify `frontend/src/locales/en.json` and `frontend/src/locales/th.json`: all page, control, role, fallback, announcement, and accessibility copy.
- Modify `README.md`: document the account/preferences behavior and client-side scope.
- Modify `CHANGELOG.md`: record the implementation under the next explicit version (`v0.3.8` if `v0.3.7` remains current).

### Task 1: Shared account navigation and sign-out contract

**Files:**
- Create: `frontend/src/lib/account.ts`
- Test: `frontend/tests/account-navigation.vitest.tsx`

**Interfaces:**
- Produces: `SETTINGS_PATH`, `PROFILE_SETTINGS_PATH`, `PREFERENCES_SETTINGS_PATH` string constants.
- Produces: `signOut(navigate: (destination: string) => void): void`.

- [ ] **Step 1: Write the failing helper tests**

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    PREFERENCES_SETTINGS_PATH,
    PROFILE_SETTINGS_PATH,
    SETTINGS_PATH,
    signOut,
} from "../src/lib/account";

describe("account navigation", () => {
    beforeEach(() => localStorage.clear());

    it("keeps account destinations canonical", () => {
        expect(SETTINGS_PATH).toBe("/settings");
        expect(PROFILE_SETTINGS_PATH).toBe("/settings#profile");
        expect(PREFERENCES_SETTINGS_PATH).toBe("/settings#preferences");
    });

    it("clears only session keys and navigates to login", () => {
        localStorage.setItem("token", "token-value");
        localStorage.setItem("user", "user-value");
        localStorage.setItem("vite-ui-theme", "dark");
        const navigate = vi.fn();

        signOut(navigate);

        expect(localStorage.getItem("token")).toBeNull();
        expect(localStorage.getItem("user")).toBeNull();
        expect(localStorage.getItem("vite-ui-theme")).toBe("dark");
        expect(navigate).toHaveBeenCalledWith("/login");
    });
});
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run: `cd frontend && bun run test -- tests/account-navigation.vitest.tsx`

Expected: FAIL because `../src/lib/account` does not exist.

- [ ] **Step 3: Add the minimal shared account contract**

```ts
export const SETTINGS_PATH = "/settings";
export const PROFILE_SETTINGS_PATH = `${SETTINGS_PATH}#profile`;
export const PREFERENCES_SETTINGS_PATH = `${SETTINGS_PATH}#preferences`;

export function signOut(navigate: (destination: string) => void) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    navigate("/login");
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `cd frontend && bun run test -- tests/account-navigation.vitest.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the helper with a changelog version entry**

Add a concise `v0.3.8 - 2026-08-11` Added entry to `CHANGELOG.md`, then run:

```bash
git add frontend/src/lib/account.ts frontend/tests/account-navigation.vitest.tsx CHANGELOG.md
git commit -m "feat: add shared account navigation contract"
```

### Task 2: Resilient theme selection contract

**Files:**
- Modify: `frontend/src/components/theme-provider.tsx`
- Test: `frontend/tests/account-preferences.vitest.tsx`

**Interfaces:**
- Produces: exported `Theme = "dark" | "light" | "system"`.
- Produces: `setTheme(theme: Theme): boolean`, returning `false` only when local persistence fails while still updating React state.

- [ ] **Step 1: Write a failing provider test**

Add a test harness to `account-preferences.vitest.tsx`:

```tsx
function ThemeHarness() {
    const { theme, setTheme } = useTheme();
    const [saved, setSaved] = useState<boolean | null>(null);
    return <>
        <output>{theme}</output>
        <output>{saved === null ? "idle" : saved ? "saved" : "not-saved"}</output>
        <button onClick={() => setSaved(setTheme("light"))}>Light</button>
    </>;
}

it("keeps the selected theme in memory when storage persistence fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
        throw new DOMException("quota", "QuotaExceededError");
    });
    render(<ThemeProvider defaultTheme="dark"><ThemeHarness /></ThemeProvider>);

    await user.click(screen.getByRole("button", { name: "Light" }));

    expect(screen.getByText("light")).toBeInTheDocument();
    expect(screen.getByText("not-saved")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test and verify the type/behavior failure**

Run: `cd frontend && bun run test -- tests/account-preferences.vitest.tsx`

Expected: FAIL because `setTheme` returns `void` and storage throws before the state update.

- [ ] **Step 3: Update the provider contract**

Export `Theme`, change the context signature to `(theme: Theme) => boolean`, update state before persistence, and catch only the storage failure:

```tsx
export type Theme = "dark" | "light" | "system";

type ThemeProviderState = {
    theme: Theme;
    setTheme: (theme: Theme) => boolean;
};

const initialState: ThemeProviderState = {
    theme: "system",
    setTheme: () => true,
};

// Inside the provider value:
setTheme: (nextTheme: Theme) => {
    setTheme(nextTheme);
    try {
        localStorage.setItem(storageKey, nextTheme);
        return true;
    } catch {
        return false;
    }
},
```

Keep the existing root-class effect unchanged. Existing callers may ignore the boolean result.

- [ ] **Step 4: Run the focused test and existing entry tests**

Run: `cd frontend && bun run test -- tests/account-preferences.vitest.tsx tests/entry-experience.vitest.tsx`

Expected: PASS for the new provider test and existing landing/login coverage.

- [ ] **Step 5: Commit the provider behavior**

Add a concise Fixed bullet for resilient theme persistence to the existing `v0.3.8` entry, then run:

```bash
git add frontend/src/components/theme-provider.tsx frontend/tests/account-preferences.vitest.tsx CHANGELOG.md
git commit -m "fix: preserve theme changes when storage fails"
```

### Task 3: Account and Preferences page

**Files:**
- Create: `frontend/src/pages/dashboard/settings/AccountPreferencesPage.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Test: `frontend/tests/account-preferences.vitest.tsx`

**Interfaces:**
- Consumes: `getStoredUser()`, `signOut()`, `useTheme()`, `useTranslation()`, and `useNavigate()`.
- Produces: default `AccountPreferencesPage` component.

- [ ] **Step 1: Write failing identity and empty-state tests**

Add a `renderPage(path = "/settings")` helper that renders the page inside `ThemeProvider`, `MemoryRouter`, and `Routes`. Seed `localStorage.user` with a named owner, then verify the heading, name, email, localized role, and absence of editable identity fields:

```tsx
expect(screen.getByRole("heading", { level: 1, name: "Account & Preferences" })).toBeInTheDocument();
expect(screen.getByText("Mali Chai")).toBeInTheDocument();
expect(screen.getAllByText("mali@example.com").length).toBeGreaterThan(0);
expect(screen.getByText("Owner")).toBeInTheDocument();
expect(screen.queryByRole("textbox", { name: /name|email/i })).not.toBeInTheDocument();
expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
```

Clear the stored user in a second test and expect `Profile unavailable`, `Email unavailable`, `Role unavailable`, and avatar fallback `U`.

- [ ] **Step 2: Run the focused test and verify the missing page failure**

Run: `cd frontend && bun run test -- tests/account-preferences.vitest.tsx`

Expected: FAIL because `AccountPreferencesPage` does not exist.

- [ ] **Step 3: Add complete bilingual copy**

Add matching `accountPreferences` objects to both locale files with keys for:

```json
{
  "title": "Account & Preferences",
  "description": "Your identity comes from your authorized Google and tenant account. Display preferences apply only to you.",
  "profile": { "title": "Profile", "description": "Read-only account identity", "name": "Name", "email": "Email", "role": "Tenant role", "unknownName": "Profile unavailable", "unknownEmail": "Email unavailable", "unknownRole": "Role unavailable" },
  "roles": { "owner": "Owner", "manager": "Manager", "collector": "Collector", "viewer": "Viewer" },
  "preferences": { "title": "Preferences", "description": "Changes apply immediately on this device.", "language": "Language", "thai": "Thai", "english": "English", "appearance": "Appearance", "light": "Light", "dark": "Dark", "system": "System", "changed": "{{preference}} changed to {{value}}.", "notPersisted": "The change is active, but could not be saved on this device." },
  "session": { "title": "Session", "description": "Sign out of CreditSync on this device.", "signedInAs": "Signed in as {{email}}", "signOut": "Sign out" }
}
```

Translate every value naturally in Thai; keep the same keys and interpolation variables.

- [ ] **Step 4: Implement the accessible page composition**

Create a centered `max-w-4xl` page with one `h1` and three Card-backed `<section>` elements:

- `id="profile"` and `id="preferences"` receive `tabIndex={-1}` and `scroll-mt-24`.
- Profile renders Avatar plus definition-list rows for name, email, and role; map only the four known roles to localized labels and use neutral fallbacks otherwise.
- Preference choices use `<fieldset>`/`<legend>` and real `<button type="button" aria-pressed={selected}>` controls with `min-h-11`; labels show Thai/English and Light/Dark/System explicitly.
- Language stores the requested `"th" | "en"` in local component state before calling `await i18n.changeLanguage(nextLanguage)` so a persistence rejection cannot make the choice unusable; theme calls `setTheme("light" | "dark" | "system")` and uses its boolean result.
- A visually hidden `<p aria-live="polite" aria-atomic="true">` reports success or the localized non-blocking persistence warning.
- Session renders the email when present and a destructive-styled sign-out button that calls `signOut(navigate)`.

Use the existing `Card`, `Button`, `Avatar`, and icon components; do not add dependencies or duplicate storage writes.

- [ ] **Step 5: Add interaction and accessibility tests**

Verify all five choices expose their selected state, clicking Thai calls `changeLanguage("th")`, clicking each theme choice updates context/storage, and the live region announces the changed value. Mock a rejected `changeLanguage` call and a `false` theme persistence result separately to verify the non-blocking warning remains visible and controls stay usable.

- [ ] **Step 6: Add hash focus behavior and its test**

In an effect keyed by `location.hash`, accept only `#profile` and `#preferences`, then schedule `element.scrollIntoView({ block: "start" })` and `element.focus({ preventScroll: true })`. In the test, stub `HTMLElement.prototype.scrollIntoView`, render `/settings#preferences`, and `waitFor` the Preferences section to have focus and the stub to be called.

- [ ] **Step 7: Verify the complete page test**

Run: `cd frontend && bun run test -- tests/account-preferences.vitest.tsx`

Expected: PASS for identity, fallback, language, theme, persistence warning, hash focus, and sign-out cases.

- [ ] **Step 8: Commit the page**

Add an Added bullet for the localized read-only identity and immediate preferences page to the existing `v0.3.8` entry, then run:

```bash
git add frontend/src/pages/dashboard/settings/AccountPreferencesPage.tsx frontend/src/locales/en.json frontend/src/locales/th.json frontend/tests/account-preferences.vitest.tsx CHANGELOG.md
git commit -m "feat: add account preferences page"
```

### Task 4: Wire protected routes and every account entry point

**Files:**
- Modify: `frontend/src/components/AppBar.tsx`
- Modify: `frontend/src/layouts/DashboardLayout.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Test: `frontend/tests/account-navigation.vitest.tsx`

**Interfaces:**
- Consumes: shared paths and `signOut()` from `frontend/src/lib/account.ts`.
- Produces: functional Profile, Settings, sidebar, legacy redirect, and logout routes.

- [ ] **Step 1: Write failing AppBar destination tests**

Render `UserAccountMenu` in a `MemoryRouter` with a location probe. Open the account menu, select Profile, and expect `/settings#profile`; repeat for Settings and expect `/settings#preferences`. Select Log out after seeding `token` and `user`, then expect `/login` and cleared session keys. Assert the avatar trigger name includes the stored display name, and falls back to localized `Open account menu` when the user is missing.

- [ ] **Step 2: Write failing sidebar and route tests**

Render `DashboardLayout` with an `Outlet` route and verify the Settings link has `href="/settings"`. Add a route harness matching the production route structure and verify `/dashboard/settings` renders the settings page through `<Navigate to={SETTINGS_PATH} replace />` rather than the fallback landing page.

- [ ] **Step 3: Run navigation tests and verify the dead ends**

Run: `cd frontend && bun run test -- tests/account-navigation.vitest.tsx`

Expected: FAIL because menu items have no navigation handlers, the sidebar points at `/dashboard/settings`, and no settings route exists.

- [ ] **Step 4: Wire the account menu**

In `AppBar.tsx`, use `useNavigate()` and shared constants. Set Radix `DropdownMenuItem onSelect` handlers to navigate to Profile and Preferences hashes. Replace `window.location.href` logout with `signOut(navigate)`. Build the trigger label with a localized interpolation such as `Open account menu for {{name}}`, falling back to the current generic label.

- [ ] **Step 5: Wire sidebar and application routes**

In `DashboardLayout.tsx`, replace the hardcoded settings href with `SETTINGS_PATH`. Add a localized `aria-label` to the mobile drawer toggle (`Open navigation` / `Close navigation`, with Thai equivalents).

In `App.tsx`, import `AccountPreferencesPage` and `SETTINGS_PATH`, then add these protected children beneath `DashboardLayout`:

```tsx
<Route path="settings" element={<AccountPreferencesPage />} />
<Route path="dashboard/settings" element={<Navigate to={SETTINGS_PATH} replace />} />
```

- [ ] **Step 6: Run navigation and page tests**

Run: `cd frontend && bun run test -- tests/account-navigation.vitest.tsx tests/account-preferences.vitest.tsx`

Expected: PASS.

- [ ] **Step 7: Commit route integration**

Add a Changed bullet for the functional account menu, canonical settings path, and legacy redirect to the existing `v0.3.8` entry, then run:

```bash
git add frontend/src/components/AppBar.tsx frontend/src/layouts/DashboardLayout.tsx frontend/src/App.tsx frontend/src/locales/en.json frontend/src/locales/th.json frontend/tests/account-navigation.vitest.tsx CHANGELOG.md
git commit -m "feat: connect account settings navigation"
```

### Task 5: Documentation, full verification, and visual QA

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: completed `/settings` behavior.
- Produces: release documentation and verification evidence.

- [ ] **Step 1: Document the shipped behavior**

Add a short “Account and display preferences” paragraph under Authentication and Access in `README.md`: identity and tenant role are read-only from the authorized account, `/settings` provides Thai/English and Light/Dark/System device preferences, and sign-out clears the local CreditSync session. Do not imply backend preference sync.

Update the existing `v0.3.8` changelog entry to summarize the unified page, working entry points/legacy redirect, immediate preferences, and shared safe sign-out.

- [ ] **Step 2: Run focused regression tests**

Run: `cd frontend && bun run test -- tests/account-preferences.vitest.tsx tests/account-navigation.vitest.tsx tests/entry-experience.vitest.tsx`

Expected: PASS.

- [ ] **Step 3: Run the full frontend suite**

Run: `cd frontend && bun run test`

Expected: PASS. If the known unrelated `frontend/tests/loan-wizard.vitest.tsx` combobox/radiogroup mismatch still fails, record the exact failure as pre-existing evidence and do not alter LoanWizard in this task.

- [ ] **Step 4: Run static verification**

Run: `cd frontend && bun run lint`

Expected: PASS.

Run: `cd frontend && bun run build`

Expected: PASS.

- [ ] **Step 5: Perform responsive and keyboard QA**

Run: `cd frontend && bun run dev -- --host 127.0.0.1`

With a safe local test session, inspect `/settings`, `/settings#profile`, `/settings#preferences`, and `/dashboard/settings` at approximately 390 px and 1440 px widths. Verify keyboard-visible focus, 44 px choice targets, active labels beyond color, avatar fallback, hash focus below the sticky header, immediate language/theme changes, mobile drawer closure, and sign-out navigation. Capture screenshots only from non-sensitive test identity data.

- [ ] **Step 6: Review the final diff for scope and secrets**

Run: `git diff --check && git status --short && git diff --stat HEAD~4..HEAD`

Expected: no whitespace errors, no `.env`/secret artifacts, and changes limited to the settings design, shared helpers, navigation, tests, locales, README, and CHANGELOG.

- [ ] **Step 7: Commit documentation and final verification record**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document account preferences workflow"
```

Before claiming completion, invoke `superpowers:verification-before-completion` and rerun any command it requires from fresh output.
