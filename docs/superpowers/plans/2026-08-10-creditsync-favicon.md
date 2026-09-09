# CreditSync Favicon and App Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved Connected Capital favicon and PWA app icon set, wire it into the Vite frontend, and verify every browser-facing asset.

**Architecture:** Keep `frontend/public/favicon.svg` as the vector source of truth. Produce checked-in PNG variants from that SVG, using a temporary small-size derivative that removes the marked detail group for the 16 px export. A Bun test validates the SVG, PNG dimensions, manifest declarations, and HTML links; the normal frontend build verifies Vite packaging.

**Tech Stack:** SVG, Bun 1.x, `bun:test`, Vite, one-off `bun x sharp-cli` rasterization.

## Global Constraints

- Use a dark navy `#070B1A` rounded-square tile.
- Use cyan `#22D3EE`, violet `#8B5CF6`, fuchsia `#D946EF`, and white `#F8FAFC` nodes.
- Keep the design flat, centered, and free of text, letters, currency symbols, shadows, and texture.
- Remove inner spokes from the 16 px raster variant; retain them at 32 px and larger.
- Keep `CreditSync` as both the full and short manifest name.
- Set manifest theme and background colors to `#070B1A`.
- Use Bun for tests, dependency management, and builds.
- Do not modify unrelated backend or loan-renewal work already present in the shared worktree.

---

### Task 1: Add the Brand Asset Contract Test

**Files:**
- Create: `frontend/scripts/brand-assets.test.ts`

**Interfaces:**
- Consumes: `frontend/public/*` brand assets, `frontend/public/site.webmanifest`, and `frontend/index.html`.
- Produces: a focused `bun:test` contract that verifies filenames, PNG dimensions, SVG design tokens, manifest data, and HTML link declarations.

- [ ] **Step 1: Write the failing test**

Create a Bun test that reads files relative to `import.meta.dir`, parses PNG IHDR width/height from bytes 16–23, and asserts:

```ts
const expectedPngDimensions = new Map([
  ["favicon-16x16.png", [16, 16]],
  ["favicon-32x32.png", [32, 32]],
  ["apple-touch-icon.png", [180, 180]],
  ["pwa-192x192.png", [192, 192]],
  ["pwa-512x512.png", [512, 512]],
]);

expect(svg).toContain("#070B1A");
expect(svg).toContain("#22D3EE");
expect(svg).toContain("#8B5CF6");
expect(svg).toContain("#D946EF");
expect(svg).toContain("#F8FAFC");
expect(manifest.name).toBe("CreditSync");
expect(manifest.short_name).toBe("CreditSync");
expect(manifest.theme_color).toBe("#070B1A");
expect(manifest.background_color).toBe("#070B1A");
```

Also assert that `frontend/index.html` references `/favicon.svg`, both PNG favicons, `/apple-touch-icon.png`, and `/site.webmanifest`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd frontend && bun test scripts/brand-assets.test.ts`

Expected: FAIL because `favicon.svg` and the manifest/PWA assets do not exist yet.

### Task 2: Create the Vector Mark and Raster Exports

**Files:**
- Create: `frontend/public/favicon.svg`
- Create: `frontend/public/favicon-16x16.png`
- Create: `frontend/public/favicon-32x32.png`
- Create: `frontend/public/apple-touch-icon.png`
- Create: `frontend/public/pwa-192x192.png`
- Create: `frontend/public/pwa-512x512.png`
- Delete: `frontend/public/vite.svg`

**Interfaces:**
- Consumes: the approved geometry and palette in `docs/superpowers/specs/2026-08-10-creditsync-favicon-design.md`.
- Produces: browser and PWA identity assets referenced by Task 3.

- [ ] **Step 1: Create the SVG source**

Create a `128 × 128` viewBox SVG with a rounded `#070B1A` tile, triangular connector path, three colored outer circles, a white center circle, and the removable detail group:

```xml
<g id="detail-spokes">
  <path d="M37 38 62 64M91 53 62 64M51 94 62 64" ... />
</g>
```

Use `shape-rendering="geometricPrecision"`, line caps/joins of `round`, and an accessible `<title>CreditSync Connected Capital icon</title>`.

- [ ] **Step 2: Produce a temporary 16 px source without inner spokes**

Run a Bun one-liner that reads `public/favicon.svg`, removes the complete `<g id="detail-spokes">...</g>` element, and writes `../tmp/creditsync-favicon-16.svg`. The temporary output stays ignored and is not committed.

- [ ] **Step 3: Rasterize all PNG outputs from SVG**

Run from `frontend/`:

```bash
bun x sharp-cli -i ../tmp/creditsync-favicon-16.svg -o public/favicon-16x16.png -f png resize 16 16
bun x sharp-cli -i public/favicon.svg -o public/favicon-32x32.png -f png resize 32 32
bun x sharp-cli -i public/favicon.svg -o public/apple-touch-icon.png -f png resize 180 180
bun x sharp-cli -i public/favicon.svg -o public/pwa-192x192.png -f png resize 192 192
bun x sharp-cli -i public/favicon.svg -o public/pwa-512x512.png -f png resize 512 512
```

If `sharp-cli` treats `-o` as a directory for this version, render to `tmp/creditsync-icons/<size>/` and move the resulting SVG-basename PNG to the exact paths above.

- [ ] **Step 4: Remove the unused Vite asset**

Delete `frontend/public/vite.svg` after `frontend/index.html` no longer references it.

### Task 3: Wire Browser and PWA Metadata

**Files:**
- Create: `frontend/public/site.webmanifest`
- Modify: `frontend/index.html:4-8`

**Interfaces:**
- Consumes: the exact asset filenames produced in Task 2.
- Produces: browser favicon discovery and installable PWA icon metadata.

- [ ] **Step 1: Add the web manifest**

Create valid JSON with this contract:

```json
{
  "name": "CreditSync",
  "short_name": "CreditSync",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#070B1A",
  "theme_color": "#070B1A",
  "icons": [
    { "src": "/pwa-192x192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/pwa-512x512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- [ ] **Step 2: Replace the Vite favicon link**

Add explicit SVG, 32 px, 16 px, Apple touch, and manifest links plus `<meta name="theme-color" content="#070B1A" />` in `frontend/index.html`.

- [ ] **Step 3: Run the brand contract test**

Run: `cd frontend && bun test scripts/brand-assets.test.ts`

Expected: PASS with all asset, dimension, manifest, palette, and HTML-link assertions succeeding.

### Task 4: Verify the Production Artifact and Document the Change

**Files:**
- Modify: `CHANGELOG.md`
- Keep unchanged: `README.md` unless implementation changes setup or workflow expectations.

**Interfaces:**
- Consumes: the completed static assets and HTML/manifest integration.
- Produces: a production-build verification record and concise release note.

- [ ] **Step 1: Add the release note**

Under `v0.3.1` → `Added`, add a concise entry stating that the Connected Capital favicon, Apple touch icon, and PWA icon set are now wired into the frontend.

- [ ] **Step 2: Run focused tests and lint checks**

Run:

```bash
cd frontend
bun test scripts/brand-assets.test.ts
bun run lint
```

Expected: brand test PASS and ESLint exits 0.

- [ ] **Step 3: Run the production build**

Run: `cd frontend && bun run build`

Expected: TypeScript and Vite build exit 0; `frontend/dist/` contains the declared favicon, touch icon, PWA icons, and manifest.

- [ ] **Step 4: Inspect the final icon**

Open `frontend/public/pwa-512x512.png` and `frontend/public/favicon-16x16.png`. Confirm the three nodes remain separate, the center hub is visible, the tile has clean rounded edges, and there are no unwanted fringes.

- [ ] **Step 5: Commit only CreditSync icon work**

Stage the plan, brand test, public assets, `frontend/index.html`, and only the icon-related `CHANGELOG.md` line. Do not stage unrelated backend, README, or renewal changelog edits.

```bash
git commit -m "feat: add CreditSync app icon"
```
