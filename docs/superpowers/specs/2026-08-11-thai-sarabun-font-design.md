# Thai Sarabun Font Design

**Version:** v0.3.9

**Date:** 2026-08-11

**Status:** Approved

## Goal

Use the self-hosted Sarabun typeface throughout the web interface whenever the active application language is Thai, while preserving the existing system sans-serif font stack for English.

## Scope

- Store Sarabun webfont assets inside the frontend project; the application must not depend on a third-party font CDN.
- Include normal font styles at weights 400, 500, 600, and 700 in WOFF2 format.
- Apply Sarabun to the complete interface when the resolved i18next language is Thai, including English text and numbers that appear within the Thai interface.
- Retain the current font behavior for English and other fallback languages.
- Keep a system sans-serif fallback after Sarabun so text remains readable if an asset cannot load.

Italic variants and additional weights are outside this change.

## Design

### Font assets and declarations

Place the four licensed WOFF2 assets under `frontend/src/assets/fonts/`. Declare one `@font-face` rule per weight in the global stylesheet, use `font-display: swap`, and reference assets through the frontend build pipeline. Include the upstream font license beside the assets.

### Language synchronization

The i18n bootstrap owns synchronization between the resolved i18next language and the root HTML `lang` attribute. It sets the attribute after initialization and updates it on each `languageChanged` event. Language values are normalized to `th` or `en`, matching the application's supported resources and avoiding region-tag-specific CSS rules.

### Font selection

Global CSS selects Sarabun only below `html:lang(th)`. The rule applies at the document body so shared components and routed screens inherit the typeface without component-specific classes. English continues to use the current platform font behavior.

Controls should inherit the document typeface. Any deliberate monospace utility remains monospace because it conveys a distinct data presentation rather than application-language typography.

## Failure behavior

If a WOFF2 asset is unavailable or rejected, the browser falls back to the configured system sans-serif stack. Font loading does not block navigation, language switching, authentication, or financial workflows.

## Verification

- Add a focused i18n test that verifies the initial resolved language updates the root `lang` attribute.
- Verify changing between Thai and English updates the attribute immediately.
- Add a source-level or browser-style assertion confirming the Thai root selector uses Sarabun and English is not forced to use it.
- Run the relevant frontend test suite, lint, and production build.
- Perform a browser smoke check in Thai and English, including regular, medium, semibold, and bold text.

## Documentation

Record the user-facing typography change in `CHANGELOG.md`. No README update is required because setup and operating workflows remain unchanged.
