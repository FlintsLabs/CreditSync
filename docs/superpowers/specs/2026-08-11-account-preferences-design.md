# Account and Preferences Design

## Purpose

Remove the current Profile and Settings dead ends with one small, functional
account destination. The page must show the signed-in identity clearly, expose
only preferences the user can actually control, and avoid implying that Google
identity or tenant role data can be edited in CreditSync.

## Approved Direction: Unified Account and Preferences

CreditSync will provide one protected route at `/settings`. Both the sidebar
Settings link and the account dropdown lead to this route:

- Profile opens `/settings#profile`.
- Settings opens `/settings#preferences`.

This preserves the meaning of both entry points without creating duplicate
pages. The destination uses the current dashboard shell and existing component
language rather than introducing a separate settings application.

## Page Structure

### Header

- Page title: `Account & Preferences` / `บัญชีและการตั้งค่า`.
- Supporting text explains that identity comes from the authorized Google and
  tenant account, while display preferences apply only to the current user.

### Profile section

- Display avatar, name, email, and tenant role.
- Treat all identity fields as read-only text; do not render disabled text
  inputs because they would imply editability.
- Use localized role labels for `owner`, `manager`, `collector`, and `viewer`.
- If a name or email is unavailable, show a localized neutral fallback rather
  than `undefined`, an empty label, or synthetic personal data.
- If the profile image is missing or fails, use the existing avatar fallback
  initial.

### Preferences section

- Language uses the existing i18next language switch behavior and offers Thai
  and English explicitly.
- Appearance uses the existing theme provider and offers Light, Dark, and
  System as a labelled control group.
- Changes take effect immediately and use the persistence mechanisms already
  owned by i18next language detection and the theme provider.
- No Save button is shown because there is no pending form or server write.
- A polite live region announces a preference change for assistive technology.

### Session section

- Show the current signed-in email when available.
- Provide one destructive-styled `Sign out` action with plain explanatory copy.
- Signing out keeps the existing behavior: remove `token` and `user` from local
  storage, then navigate to `/login`.
- Do not add password, MFA, active-session, account deletion, or Google account
  management controls because CreditSync does not own those capabilities.

## Navigation Behavior

- Add the protected child route `settings` beneath `DashboardLayout`, yielding
  `/settings` rather than `/dashboard/settings`.
- Update desktop and mobile sidebar Settings links to `/settings`.
- Account dropdown Profile and Settings items navigate to the corresponding
  hash target and close the menu.
- The page scrolls and moves focus to the requested section after hash
  navigation so the destination is apparent to keyboard and screen-reader
  users.
- Direct access to the legacy `/dashboard/settings` path redirects to
  `/settings` to avoid breaking existing bookmarks.

## Component Boundaries

- `AccountPreferencesPage` owns page composition and reads the current stored
  user through the existing session helper.
- A small shared account-navigation helper owns the `/settings#profile` and
  `/settings#preferences` destinations so sidebar and dropdown paths cannot
  drift.
- Existing `LanguageSwitcher` and theme provider behavior remain the sources of
  truth. If their current controls cannot expose all required labelled options,
  add account-page-specific accessible controls that call the same underlying
  APIs; do not create a second persistence scheme.
- Logout behavior should move to one shared helper before it is consumed by
  both `AppBar` and `AccountPreferencesPage`.

## Data Flow

1. The protected route ensures an authenticated session before rendering.
2. The page reads name, email, picture, and role from the same stored-user
   representation used by the dashboard shell.
3. Language changes call `i18n.changeLanguage("th" | "en")`.
4. Theme changes call the existing theme context with `light`, `dark`, or
   `system`.
5. Logout clears only the existing `token` and `user` keys and navigates to
   `/login`.

No backend endpoint, financial write, audit event, or tenant mutation is added.

## Error and Empty States

- Invalid stored-user JSON is handled by the existing safe session reader and
  renders localized unknown-profile fallbacks.
- A missing picture falls back to the user's first display-name character or
  `U` when no safe character is available.
- Preference controls remain usable when profile metadata is incomplete.
- If language or theme persistence fails unexpectedly, keep the selected
  in-memory state and announce a localized non-blocking warning; do not block
  navigation or logout.

## Localization and Accessibility

- Add all visible copy and role labels to both `frontend/src/locales/en.json`
  and `frontend/src/locales/th.json`.
- Use one `h1` and labelled `section` elements for Profile, Preferences, and
  Session.
- Use real buttons or radio-group semantics for theme and language choices,
  with visible focus and at least 44 px touch targets.
- Do not communicate the active preference through color alone.
- Account-menu avatar trigger receives an accessible name based on the current
  user's display name or a localized fallback.
- Hash targets must not disappear beneath the sticky mobile header.

## Verification

- Component tests verify read-only identity content and safe missing-user
  fallbacks.
- Routing tests verify sidebar, Profile, Settings, legacy redirect, and hash
  destinations.
- Interaction tests verify Thai/English changes, Light/Dark/System changes, live
  announcements, and logout storage cleanup.
- Run frontend `bun run test`, `bun run lint`, and `bun run build`.
- Manually verify `/settings`, `/settings#profile`, and
  `/settings#preferences` on mobile and desktop with keyboard navigation.

## Out of Scope

- Editing name, email, avatar, Google account, or tenant role.
- Password, MFA, session inventory, account deletion, or user administration.
- Backend profile or preference persistence.
- Redesigning the dashboard sidebar or account dropdown beyond making their
  existing destinations functional and accessible.
