import Decimal from "decimal.js";

export interface FundingAllocationLike {
    loanId: number;
    bankProfileId: number;
    allocatedAmount: string;
}

export interface TransactionComponentsLike {
    principalComponent: string;
    interestComponent: string;
    feeComponent: string;
    penaltyComponent: string;
}

export interface AttributedComponents {
    principal: Decimal;
    interest: Decimal;
    fees: Decimal;
    penalties: Decimal;
}

export function buildPositiveFundingShares(rows: FundingAllocationLike[]) {
    const netByLoan = new Map<number, Map<number, Decimal>>();

    for (const row of rows) {
        const bySource = netByLoan.get(row.loanId) ?? new Map<number, Decimal>();
        bySource.set(
            row.bankProfileId,
            (bySource.get(row.bankProfileId) ?? new Decimal(0)).plus(row.allocatedAmount),
        );
        netByLoan.set(row.loanId, bySource);
    }

    const sharesByLoan = new Map<number, Map<number, Decimal>>();
    for (const [loanId, bySource] of netByLoan) {
        const positive = [...bySource].filter(([, amount]) => amount.gt(0));
        const total = positive.reduce((sum, [, amount]) => sum.plus(amount), new Decimal(0));
        if (total.lte(0)) continue;
        sharesByLoan.set(loanId, new Map(
            positive.map(([sourceId, amount]) => [sourceId, amount.div(total)]),
        ));
    }

    return sharesByLoan;
}

export function attributeTransactionComponents(input: {
    sourceShare: Decimal.Value;
    transactions: TransactionComponentsLike[];
}): AttributedComponents {
    const share = new Decimal(input.sourceShare);
    return input.transactions.reduce<AttributedComponents>((total, transaction) => ({
        principal: total.principal.plus(new Decimal(transaction.principalComponent).times(share)),
        interest: total.interest.plus(new Decimal(transaction.interestComponent).times(share)),
        fees: total.fees.plus(new Decimal(transaction.feeComponent).times(share)),
        penalties: total.penalties.plus(new Decimal(transaction.penaltyComponent).times(share)),
    }), {
        principal: new Decimal(0),
        interest: new Decimal(0),
        fees: new Decimal(0),
        penalties: new Decimal(0),
    });
}
