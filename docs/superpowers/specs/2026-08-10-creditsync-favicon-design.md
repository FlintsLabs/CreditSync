# CreditSync Favicon and App Icon Design

## Purpose

Create a distinctive favicon and app icon for CreditSync, a mobile-first loan management system. The mark must remain recognizable in a 16 px browser tab while also scaling cleanly to PWA and app-launcher sizes.

## Approved Direction: Connected Capital

The icon uses three colored outer nodes connected to a white central hub:

- Cyan node: funding sources entering the system.
- Violet node: active loan agreements and portfolio management.
- Fuchsia node: repayments returning through the workflow.
- White center: the synchronized ledger that connects and reconciles the three flows.

The outer nodes form an asymmetric triangular network. This references CreditSync's portfolio graph without becoming a generic chart or currency symbol.

## Visual System

### Shape

- A square tile with a 22–24% corner radius.
- Three circular outer nodes connected by a triangular path.
- Three spokes connecting the outer nodes to a circular central hub in the primary mark.
- Centered composition with at least 12% clear space on every edge.
- Flat vector geometry without shadows, texture, text, letters, or currency symbols.

### Color

| Role | Color |
| --- | --- |
| Tile background | `#070B1A` |
| Funding node | `#22D3EE` |
| Loan node and primary connector | `#8B5CF6` |
| Repayment node | `#D946EF` |
| Synced ledger hub | `#F8FAFC` |
| Primary inner spoke | `#C4B5FD` at 72% opacity |

These colors reuse the cyan–violet–fuchsia palette already present on the CreditSync landing and login pages. The dark navy tile provides consistent contrast against both light and dark browser chrome.

### Small-Size Adaptation

The 16 px favicon variant removes the three inner spokes and increases the apparent width of the triangle and nodes. The white center remains as a simple sync point. The 32 px and larger variants retain the inner spokes.

## Deliverables

- `frontend/public/favicon.svg`: scalable primary favicon with the 32 px-and-larger geometry.
- `frontend/public/favicon-16x16.png`: simplified small-size raster export.
- `frontend/public/favicon-32x32.png`: standard browser raster export.
- `frontend/public/apple-touch-icon.png`: 180 × 180 px touch icon.
- `frontend/public/pwa-192x192.png`: 192 × 192 px PWA icon.
- `frontend/public/pwa-512x512.png`: 512 × 512 px PWA icon.
- `frontend/public/site.webmanifest`: application name, short name, theme colors, and PWA icon declarations.

The SVG is the source of truth. Raster files must be generated from it rather than redrawn independently.

## Integration

- Replace the default Vite favicon reference in `frontend/index.html` with `/favicon.svg`.
- Add explicit 16 px, 32 px, Apple touch, and web manifest links.
- Set the manifest theme and background colors to `#070B1A`.
- Keep `CreditSync` as the full application name and short name.
- Do not replace bank-specific icons or Lucide interface icons; this mark is only for application identity.

## Verification

- Confirm every referenced asset exists and loads in the production frontend build.
- Render and inspect the icon at 16, 32, 64, 180, 192, and 512 px.
- Check the 16 px mark on light and dark browser chrome for node separation and center visibility.
- Confirm PNG dimensions and alpha/color mode using an image metadata tool.
- Run the frontend build with Bun and verify there are no missing-asset warnings.

## Out of Scope

- A horizontal wordmark or typography system.
- Animated logo treatments.
- Redesigning the landing page, login screen, sidebar, or navigation icons.
- Native iOS or Android adaptive-icon packaging beyond the web/PWA assets listed above.
