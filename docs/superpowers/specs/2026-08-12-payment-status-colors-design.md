# Payment Status Colors Design

## Goal

Make Payment Inbox statuses distinguishable at a glance while preserving readable text labels and accessible light/dark-mode contrast.

## Approved palette

- `ready`: green, indicating valid and ready for the next action.
- `draft`: neutral gray, indicating unfinished work.
- `needs_review`: amber, indicating attention without implying failure.
- `posted`: blue, indicating a completed accounting action distinct from readiness.
- `reversed`: red, indicating a compensating reversal.
- `duplicate`: orange, indicating a blocked duplicate distinct from reversal.

The shared mapping must style both background and text/border contrast. Labels remain visible so color is never the only status signal. Unknown statuses fall back to the neutral badge appearance.

## Scope and verification

Apply the mapping to Payment Inbox rows only, without changing financial state or API behavior. Add a focused component test that exercises every known status and asserts its semantic tone marker, then run the full frontend test, lint, and build suites.
