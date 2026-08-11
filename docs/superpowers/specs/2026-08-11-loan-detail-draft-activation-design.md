# Loan Detail Draft Activation Design

## Goal

Allow an existing loan draft—including one created through MCP—to be activated safely from its canonical Loan Detail page. Activation remains a separate, explicit command that locks financial terms.

## User experience

- Show a primary **Activate loan** action in the Loan Detail header only when the loaded loan status is `draft`.
- Opening the action presents a confirmation dialog; the first click never activates the loan.
- The dialog summarizes the borrower, principal, repayment type, start date, and available daily/floating-interest terms using backend-owned values and exact decimal-string formatting.
- The dialog states that activation locks the terms and creates any applicable immutable schedule.
- Confirming calls `POST /loans/:publicId/activate` once. Both dialog actions are disabled while the request is pending.
- On success, replace the page's loan state with the activated response so the status becomes `active`, close the dialog, and remove the activation action without requiring navigation.
- On failure, leave the draft unchanged, keep the user on the page, and show a localized error message that can be retried safely.

## Component and data boundaries

- Keep the activation UI in `LoanDetail.tsx`, reusing the existing authenticated API client and shared Button/Dialog components.
- Do not calculate schedules, interest, net disbursement, or accounting values in the frontend. The frontend only presents fields returned by the loan detail contract.
- The existing backend activation endpoint remains the single command boundary; no backend workflow change is required.
- Actual disbursement posting remains independent and is not triggered by loan activation.

## Localization and accessibility

- Add matching Thai and English translation keys for the action, dialog title, irreversible-lock warning, summary labels, pending state, cancel action, and error.
- Give the dialog an accessible title and description, preserve focus behavior from the shared dialog primitive, and expose a clear pending label while activation runs.

## Verification

- A draft loan renders the activation action; an active loan does not.
- Opening the action shows the financial summary but makes no API mutation.
- Confirming sends the exact public UUID to `POST /loans/:id/activate`, disables repeat submission, and updates the page to `active` on success.
- A failed request keeps the loan as `draft` and renders the localized error.
- Run the focused frontend test, frontend lint/build, and production browser QA for draft and active states.

## Out of scope

- Editing draft terms from Loan Detail.
- Automatically posting a disbursement when a loan is activated.
- Adding a background interest-accrual worker.
