# Loan-list contract summary design

**Date:** 2026-08-10  
**Status:** Approved for implementation

## Purpose

Make every loan card understandable without opening its detail page. The list must describe the borrower's repayment agreement and dates clearly, rather than foregrounding internal funding and profitability metrics.

## Card content

The card retains borrower name, public loan ID, principal, and lifecycle status. It adds a localized contract-summary section:

- Repayment type: daily, weekly, monthly, or floating.
- For daily, weekly, and monthly loans: the agreed installment amount and total installment count when each exists.
- For floating loans: a localized statement that it has no fixed repayment schedule. It does not attempt to derive a payment amount in the client.
- Start date, labelled as the loan's transaction/start date. If absent, render a localized unavailable value.
- Record creation date and time, labelled as creation time and formatted in `Asia/Bangkok` using the active application language.

The list endpoint will expose the existing `startDate` field alongside the terms already returned. Exact serialized money strings remain the backend contract; the UI uses the established exact-money formatter rather than JavaScript number conversion.

## Funding/profitability information

Remove funding state, allocation gap, realized spread, and unrealized spread from the list cards. These are operational funding metrics, not borrower-facing contract terms:

- funding state describes whether a funding source has been allocated to the loan;
- allocation gap is the unallocated portion of principal;
- realized spread is collected borrower revenue less paid funding cost;
- unrealized spread is expected remaining borrower revenue less allocated outstanding funding cost.

They remain available on the loan detail and funding-focused pages. The list will no longer make one request for allocation state and one for profitability per card.

## Localization and presentation

Add matching English and Thai translation keys for labels, repayment type summary text, the no-fixed-schedule state, and missing start date. Date-only values stay date-only. The creation timestamp includes date and time, is explicitly labelled, and is displayed in the Bangkok business timezone.

## Error handling

If the loan list request succeeds with a nullable term field, the card shows the localized unavailable state rather than inventing a value. A failure to load the list retains the existing non-disruptive behavior. The change introduces no new financial writes or client-side financial calculations.

## Verification

Add a focused frontend component test that mocks list data for a fixed-schedule loan and a floating loan. Verify localized contract fields, start-date fallback, Bangkok creation timestamp label, and absence of funding/profitability fields. Verify the list requires only the loan-list request, then run the targeted frontend test, lint, and production build.
