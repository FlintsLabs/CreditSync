# Own Capital Recovered Cash Design

## Goal

Make a personal capital-pool source's available-capital figure represent capital that can be reused after borrower cash has been collected from loans explicitly linked to that source.

## Current behavior

The funding-usage endpoint currently calculates available capital as:

`creditLimit - netAllocatedPrincipal`

This treats every allocated amount as unavailable even after linked loans have returned borrower cash. The same endpoint already derives positive source allocations and the fund settlement code already attributes borrower transactions to a source by each loan's funding share.

## Approved behavior

For `capital_pool` sources only, calculate:

`availableAmount = creditLimit - netAllocatedPrincipal + linkedBorrowerCashCollected`

where `linkedBorrowerCashCollected` is the sum of the full borrower payment amount (`transactions.amount`) attributed to loans with a positive net allocation to this source. Attribution uses the source's positive allocation share of each loan's total positive funding allocation. This includes principal, interest, fees, and penalties.

Loans with no positive allocation to the source contribute zero, even if they have borrower payments. Negative/reversal allocation history must not create a source link by itself.

External-liability/bank sources retain the existing available-capacity behavior based on drawdown capacity; their available amount must not include borrower collections.

## Metric boundaries

- Available own capital is a reusable cash-capacity measure, not a profit measure.
- Realized ROI remains `realizedSpread / deployedPrincipal * 100`.
- `realizedSpread` continues to include borrower revenue (interest, fees, penalties) less paid upstream funding costs and does not treat returned principal as profit.
- Existing settlement and profitability metrics remain unchanged.

## API and UI

The funding-usage response should expose the attributed linked borrower cash total alongside `availableAmount` so the calculation is inspectable. The UI should explain that available own capital includes all cash collected from linked borrower loans and excludes unlinked loans. Existing financial values remain exact decimal strings.

## Testing

- A capital-pool source with a linked loan payment increases available amount by the source-attributed full payment amount.
- A payment on a loan with no allocation to the source does not increase available amount.
- A partially funded loan contributes only its source allocation share.
- External-liability sources do not add borrower collections to available amount.
- Existing settlement/ROI expectations remain unchanged.
