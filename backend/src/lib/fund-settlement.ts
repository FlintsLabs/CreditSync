import { and, eq, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../db";
import {
    bankLoanRepayments,
    bankLoans,
    fundLedgerEntries,
    fundRolloverEntries,
    loanFundingAllocations,
    loans,
    transactions,
} from "../db/schema";
import { buildPositiveFundingShares } from "./fund-attribution";

export function calculateOpportunityCost(input: {
    principal: string;
    annualRate: string;
    allocationDate: string;
    asOfDate: string;
}) {
    const start = Date.parse(`${input.allocationDate}T00:00:00Z`);
    const end = Date.parse(`${input.asOfDate}T00:00:00Z`);
    const elapsedDays = Number.isFinite(start) && Number.isFinite(end)
        ? Math.max(0, Math.floor((end - start) / 86_400_000))
        : 0;
    return new Decimal(input.principal)
        .times(input.annualRate)
        .div(100)
        .times(elapsedDays)
        .div(365)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toFixed(2);
}

interface AllocationLike {
    loanId: number;
    allocatedAmount: string;
    totalPositiveAllocatedAmount?: string;
}

interface FundRevenueLedgerEntryLike {
    entryType: string;
    amount: string;
}

export type FundRevenueReconciliation = {
    contractAttributedRevenue: string;
    ledgerRecordedRevenue: string;
    difference: string;
    status: "matched" | "needs_reconciliation";
};

const FUND_REVENUE_ENTRY_TYPES = new Set([
    "interest_income_in",
    "fee_income_in",
    "penalty_income_in",
]);

export function reconcileFundRevenue(input: {
    contractAttributedRevenue: string;
    ledgerEntries: FundRevenueLedgerEntryLike[];
}): FundRevenueReconciliation {
    const contractAttributedRevenue = new Decimal(input.contractAttributedRevenue);
    const ledgerRecordedRevenue = input.ledgerEntries.reduce(
        (total, entry) => FUND_REVENUE_ENTRY_TYPES.has(entry.entryType)
            ? total.plus(entry.amount)
            : total,
        new Decimal(0),
    );
    const difference = contractAttributedRevenue.minus(ledgerRecordedRevenue);
    return {
        contractAttributedRevenue: contractAttributedRevenue.toFixed(2),
        ledgerRecordedRevenue: ledgerRecordedRevenue.toFixed(2),
        difference: difference.toFixed(2),
        status: difference.isZero() ? "matched" : "needs_reconciliation",
    };
}

interface LoanLike {
    id: number;
    principalAmount: string;
    outstandingInterest?: string | null;
    outstandingFees?: string | null;
}

interface BorrowerTransactionLike {
    loanId: number;
    principalComponent: string;
    interestComponent: string;
    feeComponent: string;
    penaltyComponent: string;
}

interface BankRepaymentLike {
    principalComponent: string;
    interestComponent: string;
    feeComponent: string;
    vatComponent: string;
    penaltyComponent: string;
}

interface RolloverLike {
    amount: string;
    direction: "in" | "out";
    entryType?: string;
}

interface SettlementSummaryLike {
    borrowerInterestCollected: string;
    borrowerFeesCollected: string;
    borrowerPenaltiesCollected: string;
    bankInterestPaid: string;
    bankFeesPaid: string;
    bankVatPaid: string;
    bankPenaltiesPaid: string;
    realizedSpread: string;
    unrealizedSpread: string;
    surplusBalance: string;
    deficitBalance: string;
    carryForwardAvailable: string;
}

export function deriveProfitabilityMetrics(summary: SettlementSummaryLike, deployedPrincipalValue: Decimal.Value) {
    const deployedPrincipal = Decimal.max(0, new Decimal(deployedPrincipalValue));
    const borrowerRevenueCollected =
        new Decimal(summary.borrowerInterestCollected)
            .plus(summary.borrowerFeesCollected)
            .plus(summary.borrowerPenaltiesCollected);
    const fundCostPaid =
        new Decimal(summary.bankInterestPaid)
            .plus(summary.bankFeesPaid)
            .plus(summary.bankVatPaid)
            .plus(summary.bankPenaltiesPaid);
    const netCashPosition = new Decimal(summary.surplusBalance).minus(summary.deficitBalance);
    const realizedRoiPercent = deployedPrincipal.gt(0)
        ? new Decimal(summary.realizedSpread).div(deployedPrincipal).times(100)
        : new Decimal(0);

    return {
        borrowerRevenueCollected: borrowerRevenueCollected.toFixed(2),
        fundCostPaid: fundCostPaid.toFixed(2),
        realizedSpread: new Decimal(summary.realizedSpread).toFixed(2),
        unrealizedSpread: new Decimal(summary.unrealizedSpread).toFixed(2),
        deployedPrincipal: deployedPrincipal.toFixed(2),
        netCashPosition: netCashPosition.toFixed(2),
        realizedRoiPercent: realizedRoiPercent.toFixed(2),
        carryForwardAvailable: new Decimal(summary.carryForwardAvailable).toFixed(2),
    };
}

export function computeFundSettlementSummary(input: {
    allocations: AllocationLike[];
    loans: LoanLike[];
    borrowerTransactions: BorrowerTransactionLike[];
    bankRepayments: BankRepaymentLike[];
    rollovers?: RolloverLike[];
    outstandingInterest?: string | null;
    outstandingFees?: string | null;
    outstandingPenalties?: string | null;
}) {
    const loanMap = new Map(input.loans.map((loan) => [loan.id, loan]));
    const allocationAmountByLoan = new Map<number, Decimal>();
    const allocationDenominatorByLoan = new Map<number, Decimal>();
    for (const allocation of input.allocations) {
        allocationAmountByLoan.set(
            allocation.loanId,
            (allocationAmountByLoan.get(allocation.loanId) ?? new Decimal(0)).plus(allocation.allocatedAmount),
        );
        if (allocation.totalPositiveAllocatedAmount !== undefined) {
            allocationDenominatorByLoan.set(
                allocation.loanId,
                new Decimal(allocation.totalPositiveAllocatedAmount),
            );
        }
    }
    const allocationShareByLoan = new Map<number, Decimal>();
    for (const [loanId, allocatedAmount] of allocationAmountByLoan) {
        if (allocatedAmount.lte(0)) continue;
        const loan = loanMap.get(loanId);
        if (!loan) continue;
        const denominator = allocationDenominatorByLoan.get(loanId) ?? new Decimal(loan.principalAmount);
        if (denominator.lte(0)) continue;
        allocationShareByLoan.set(loanId, Decimal.min(1, allocatedAmount.div(denominator)));
    }

    let borrowerPrincipalCollected = new Decimal(0);
    let borrowerInterestCollected = new Decimal(0);
    let borrowerFeesCollected = new Decimal(0);
    let borrowerPenaltiesCollected = new Decimal(0);

    for (const tx of input.borrowerTransactions) {
        const share = allocationShareByLoan.get(tx.loanId) ?? new Decimal(0);
        borrowerPrincipalCollected = borrowerPrincipalCollected.plus(new Decimal(tx.principalComponent).times(share));
        borrowerInterestCollected = borrowerInterestCollected.plus(new Decimal(tx.interestComponent).times(share));
        borrowerFeesCollected = borrowerFeesCollected.plus(new Decimal(tx.feeComponent).times(share));
        borrowerPenaltiesCollected = borrowerPenaltiesCollected.plus(new Decimal(tx.penaltyComponent).times(share));
    }

    const sumBankComponent = (key: keyof BankRepaymentLike) => input.bankRepayments.reduce(
        (sum, row) => sum.plus(row[key]),
        new Decimal(0),
    );
    const bankPrincipalPaid = sumBankComponent("principalComponent");
    const bankInterestPaid = sumBankComponent("interestComponent");
    const bankFeesPaid = sumBankComponent("feeComponent");
    const bankVatPaid = sumBankComponent("vatComponent");
    const bankPenaltiesPaid = sumBankComponent("penaltyComponent");

    const rolloverIn = (input.rollovers ?? [])
        .filter((row) => row.direction === "in")
        .reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
    const rolloverOut = (input.rollovers ?? [])
        .filter((row) => row.direction === "out")
        .reduce((sum, row) => sum.plus(row.amount), new Decimal(0));

    const realizedSpread =
        borrowerInterestCollected
            .plus(borrowerFeesCollected)
            .plus(borrowerPenaltiesCollected)
            .minus(bankInterestPaid)
            .minus(bankFeesPaid)
            .minus(bankVatPaid)
            .minus(bankPenaltiesPaid);

    const currentNetCash =
        borrowerPrincipalCollected
            .plus(borrowerInterestCollected)
            .plus(borrowerFeesCollected)
            .plus(borrowerPenaltiesCollected)
            .minus(bankPrincipalPaid)
            .minus(bankInterestPaid)
            .minus(bankFeesPaid)
            .minus(bankVatPaid)
            .minus(bankPenaltiesPaid)
            .plus(rolloverIn)
            .minus(rolloverOut);

    const remainingBorrowerInterest = [...allocationAmountByLoan.keys()].reduce((sum, loanId) => {
        const loan = loanMap.get(loanId);
        if (!loan) return sum;
        const share = allocationShareByLoan.get(loanId) ?? new Decimal(0);
        return sum.plus(new Decimal(loan.outstandingInterest ?? 0).plus(loan.outstandingFees ?? 0).times(share));
    }, new Decimal(0));

    const remainingBankCost =
        new Decimal(input.outstandingInterest ?? 0)
            .plus(input.outstandingFees ?? 0)
            .plus(input.outstandingPenalties ?? 0);

    const unrealizedSpread = remainingBorrowerInterest.minus(remainingBankCost);
    const surplusBalance = Decimal.max(0, currentNetCash);
    const deficitBalance = Decimal.max(0, currentNetCash.negated());

    const borrowerRevenueCollected =
        borrowerInterestCollected.plus(borrowerFeesCollected).plus(borrowerPenaltiesCollected);
    const fundCostPaid =
        bankInterestPaid.plus(bankFeesPaid).plus(bankVatPaid).plus(bankPenaltiesPaid);

    return {
        borrowerPrincipalCollected: borrowerPrincipalCollected.toFixed(2),
        borrowerInterestCollected: borrowerInterestCollected.toFixed(2),
        borrowerFeesCollected: borrowerFeesCollected.toFixed(2),
        borrowerPenaltiesCollected: borrowerPenaltiesCollected.toFixed(2),
        borrowerCashCollected: borrowerPrincipalCollected.plus(borrowerRevenueCollected).toFixed(2),
        borrowerRevenueCollected: borrowerRevenueCollected.toFixed(2),
        bankPrincipalPaid: bankPrincipalPaid.toFixed(2),
        bankInterestPaid: bankInterestPaid.toFixed(2),
        bankFeesPaid: bankFeesPaid.toFixed(2),
        bankVatPaid: bankVatPaid.toFixed(2),
        bankPenaltiesPaid: bankPenaltiesPaid.toFixed(2),
        fundCostPaid: fundCostPaid.toFixed(2),
        realizedSpread: realizedSpread.toFixed(2),
        unrealizedSpread: unrealizedSpread.toFixed(2),
        rolloverIn: rolloverIn.toFixed(2),
        rolloverOut: rolloverOut.toFixed(2),
        surplusBalance: surplusBalance.toFixed(2),
        deficitBalance: deficitBalance.toFixed(2),
        carryForwardAvailable: surplusBalance.toFixed(2),
    };
}

export async function getTenantProfitabilitySummary(tenantId: string) {
    const [allAllocations, allLoans, borrowerTransactions, bankRepayments, rollovers] = await Promise.all([
        db.select().from(loanFundingAllocations).where(eq(loanFundingAllocations.tenantId, tenantId)),
        db.select().from(loans).where(eq(loans.tenantId, tenantId)),
        db.select({
            loanId: transactions.loanId,
            principalComponent: transactions.principalComponent,
            interestComponent: transactions.interestComponent,
            feeComponent: transactions.feeComponent,
            penaltyComponent: transactions.penaltyComponent,
        }).from(transactions).where(eq(transactions.tenantId, tenantId)),
        db.select({
            principalComponent: bankLoanRepayments.principalComponent,
            interestComponent: bankLoanRepayments.interestComponent,
            feeComponent: bankLoanRepayments.feeComponent,
            vatComponent: bankLoanRepayments.vatComponent,
            penaltyComponent: bankLoanRepayments.penaltyComponent,
        }).from(bankLoanRepayments).where(eq(bankLoanRepayments.tenantId, tenantId)),
        db.select().from(fundRolloverEntries).where(eq(fundRolloverEntries.tenantId, tenantId)),
    ]);

    const bankDrawdowns = await db.select().from(bankLoans).where(eq(bankLoans.tenantId, tenantId));

    const summary = computeFundSettlementSummary({
        allocations: allAllocations.map((row) => ({
            loanId: row.loanId,
            allocatedAmount: row.allocatedAmount,
        })),
        loans: allLoans,
        borrowerTransactions,
        bankRepayments,
        rollovers: rollovers.map((row) => {
            // We need to determine direction for the tenant summary.
            // If it has fromBankProfileId, it's out from some pool.
            // If it has toBankProfileId, it's in to some pool.
            // For a TENANT summary, internal transfers (both from and to inside the same tenant) cancel out.
            // Only external entries (like deficit_support without a "from") should affect net cash.
            
            let direction: "in" | "out" | "internal" = "internal";
            if (row.fromBankProfileId && !row.toBankProfileId) direction = "out";
            if (!row.fromBankProfileId && row.toBankProfileId) direction = "in";
            
            return {
                amount: row.amount,
                direction: direction as any,
                entryType: row.entryType,
            };
        }).filter(r => r.direction !== "internal"),
        outstandingInterest: bankDrawdowns.reduce((sum, row) => sum + Number(row.outstandingInterest ?? 0), 0).toFixed(2),
        outstandingFees: bankDrawdowns.reduce((sum, row) => sum + Number(row.outstandingFees ?? 0), 0).toFixed(2),
        outstandingPenalties: bankDrawdowns.reduce((sum, row) => sum + Number(row.outstandingPenalties ?? 0), 0).toFixed(2),
    });

    const deployedPrincipal = Math.max(
        0,
        allAllocations.reduce((sum, row) => sum + Number(row.allocatedAmount || 0), 0)
    );

    return deriveProfitabilityMetrics(summary, deployedPrincipal);
}

export async function getBankProfileSettlementSummary(tenantId: string, bankProfileId: number) {
    const drawdowns = await db.select().from(bankLoans).where(
        and(
            eq(bankLoans.tenantId, tenantId),
            eq(bankLoans.bankProfileId, bankProfileId),
        )
    );

    const drawdownIds = drawdowns.map((row) => row.id);
    const sourceAllocations = await db.select().from(loanFundingAllocations).where(
        and(
            eq(loanFundingAllocations.tenantId, tenantId),
            eq(loanFundingAllocations.bankProfileId, bankProfileId),
        )
    );
    const loanIds = Array.from(new Set(sourceAllocations.map((row) => row.loanId)));
    const allAllocations = loanIds.length === 0
        ? []
        : await db.select().from(loanFundingAllocations).where(
            and(
                eq(loanFundingAllocations.tenantId, tenantId),
                inArray(loanFundingAllocations.loanId, loanIds),
            )
        );
    const allocatedLoans = loanIds.length === 0
        ? []
        : await db.select().from(loans).where(
            and(
                eq(loans.tenantId, tenantId),
                inArray(loans.id, loanIds),
            )
        );
    const borrowerTransactions = loanIds.length === 0
        ? []
        : await db.select({
            loanId: transactions.loanId,
            principalComponent: transactions.principalComponent,
            interestComponent: transactions.interestComponent,
            feeComponent: transactions.feeComponent,
            penaltyComponent: transactions.penaltyComponent,
        }).from(transactions).where(
            and(
                eq(transactions.tenantId, tenantId),
                inArray(transactions.loanId, loanIds),
            )
        );
    const bankRepayments = drawdownIds.length === 0
        ? []
        : await db.select({
            principalComponent: bankLoanRepayments.principalComponent,
            interestComponent: bankLoanRepayments.interestComponent,
            feeComponent: bankLoanRepayments.feeComponent,
            vatComponent: bankLoanRepayments.vatComponent,
            penaltyComponent: bankLoanRepayments.penaltyComponent,
        }).from(bankLoanRepayments).where(
            and(
                eq(bankLoanRepayments.tenantId, tenantId),
                inArray(bankLoanRepayments.bankLoanId, drawdownIds),
            )
        );
    const outgoingRollovers = await db.select().from(fundRolloverEntries).where(
        and(
            eq(fundRolloverEntries.tenantId, tenantId),
            eq(fundRolloverEntries.fromBankProfileId, bankProfileId),
        )
    );
    const incomingRollovers = await db.select().from(fundRolloverEntries).where(
        and(
            eq(fundRolloverEntries.tenantId, tenantId),
            eq(fundRolloverEntries.toBankProfileId, bankProfileId),
        )
    );
    const ledgerEntries = await db.select().from(fundLedgerEntries).where(
        and(
            eq(fundLedgerEntries.tenantId, tenantId),
            eq(fundLedgerEntries.bankProfileId, bankProfileId),
        )
    );

    const sharesByLoan = buildPositiveFundingShares(allAllocations.flatMap((allocation) => allocation.bankProfileId === null
        ? []
        : [{
            loanId: allocation.loanId,
            bankProfileId: allocation.bankProfileId,
            allocatedAmount: allocation.allocatedAmount,
        }]
    ));
    const sourceNetByLoan = sourceAllocations.reduce((totals, allocation) => {
        totals.set(
            allocation.loanId,
            (totals.get(allocation.loanId) ?? new Decimal(0)).plus(allocation.allocatedAmount),
        );
        return totals;
    }, new Map<number, Decimal>());
    const normalizedAllocations = [...sourceNetByLoan.entries()]
        .filter(([, amount]) => amount.gt(0))
        .map(([loanId, allocatedAmount]) => {
            const sourceShare = sharesByLoan.get(loanId)?.get(bankProfileId) ?? new Decimal(0);
            const totalPositiveAllocatedAmount = sourceShare.gt(0)
                ? allocatedAmount.div(sourceShare)
                : new Decimal(0);
            return {
                loanId,
                allocatedAmount: allocatedAmount.toFixed(2),
                totalPositiveAllocatedAmount: totalPositiveAllocatedAmount.toFixed(2),
            };
        });

    const summary = computeFundSettlementSummary({
        allocations: normalizedAllocations,
        loans: allocatedLoans,
        borrowerTransactions,
        bankRepayments,
        rollovers: [
            ...incomingRollovers.map((row) => ({ amount: row.amount, direction: "in" as const, entryType: row.entryType })),
            ...outgoingRollovers.map((row) => ({ amount: row.amount, direction: "out" as const, entryType: row.entryType })),
        ],
        outstandingInterest: drawdowns.reduce((sum, row) => sum.plus(row.outstandingInterest ?? 0), new Decimal(0)).toFixed(2),
        outstandingFees: drawdowns.reduce((sum, row) => sum.plus(row.outstandingFees ?? 0), new Decimal(0)).toFixed(2),
        outstandingPenalties: drawdowns.reduce((sum, row) => sum.plus(row.outstandingPenalties ?? 0), new Decimal(0)).toFixed(2),
    });

    const poolCurrentBalance = ledgerEntries.reduce((sum, row) => {
        const amount = new Decimal(row.amount);
        return row.entryType.endsWith("_out") ? sum.minus(amount) : sum.plus(amount);
    }, new Decimal(0));
    const reconciliation = reconcileFundRevenue({
        contractAttributedRevenue: summary.borrowerRevenueCollected,
        ledgerEntries,
    });

    return {
        bankProfileId,
        drawdownCount: drawdowns.length,
        ...summary,
        reconciliation,
        poolCurrentBalance: poolCurrentBalance.toFixed(2),
        ownerSupportTotal: incomingRollovers
            .filter((row) => row.entryType === "deficit_support")
            .reduce((sum, row) => sum.plus(row.amount), new Decimal(0))
            .toFixed(2),
    };
}

export async function getBankLoanSettlementSummary(tenantId: string, bankLoanId: number) {
    const drawdown = await db.query.bankLoans.findFirst({
        where: and(eq(bankLoans.id, bankLoanId), eq(bankLoans.tenantId, tenantId)),
    });

    if (!drawdown) {
        return null;
    }

    const sourceAllocations = await db.select().from(loanFundingAllocations).where(
        and(
            eq(loanFundingAllocations.tenantId, tenantId),
            eq(loanFundingAllocations.bankLoanId, bankLoanId),
        )
    );
    const loanIds = Array.from(new Set(sourceAllocations.map((row) => row.loanId)));
    const allAllocations = loanIds.length === 0
        ? []
        : await db.select().from(loanFundingAllocations).where(
            and(
                eq(loanFundingAllocations.tenantId, tenantId),
                inArray(loanFundingAllocations.loanId, loanIds),
            )
        );
    const allocatedLoans = loanIds.length === 0
        ? []
        : await db.select().from(loans).where(
            and(
                eq(loans.tenantId, tenantId),
                inArray(loans.id, loanIds),
            )
        );
    const borrowerTransactions = loanIds.length === 0
        ? []
        : await db.select({
            loanId: transactions.loanId,
            principalComponent: transactions.principalComponent,
            interestComponent: transactions.interestComponent,
            feeComponent: transactions.feeComponent,
            penaltyComponent: transactions.penaltyComponent,
        }).from(transactions).where(
            and(
                eq(transactions.tenantId, tenantId),
                inArray(transactions.loanId, loanIds),
            )
        );
    const bankRepayments = await db.select({
        principalComponent: bankLoanRepayments.principalComponent,
        interestComponent: bankLoanRepayments.interestComponent,
        feeComponent: bankLoanRepayments.feeComponent,
        vatComponent: bankLoanRepayments.vatComponent,
        penaltyComponent: bankLoanRepayments.penaltyComponent,
    }).from(bankLoanRepayments).where(
        and(
            eq(bankLoanRepayments.tenantId, tenantId),
            eq(bankLoanRepayments.bankLoanId, bankLoanId),
        )
    );
    const outgoingRollovers = await db.select().from(fundRolloverEntries).where(
        and(
            eq(fundRolloverEntries.tenantId, tenantId),
            eq(fundRolloverEntries.fromBankLoanId, bankLoanId),
        )
    );
    const incomingRollovers = await db.select().from(fundRolloverEntries).where(
        and(
            eq(fundRolloverEntries.tenantId, tenantId),
            eq(fundRolloverEntries.toBankLoanId, bankLoanId),
        )
    );

    const normalizedAllocations = sourceAllocations.map((allocation) => {
        const totalAllocatedForLoan = allAllocations
            .filter((row) => row.loanId === allocation.loanId)
            .reduce((sum, row) => sum + Number(row.allocatedAmount), 0);
        const loan = allocatedLoans.find((row) => row.id === allocation.loanId);
        const principalBase = totalAllocatedForLoan > 0 ? totalAllocatedForLoan : Number(loan?.principalAmount ?? 0);
        const normalizedAmount = principalBase > 0 ? Number(allocation.allocatedAmount) : 0;

        return {
            loanId: allocation.loanId,
            allocatedAmount: normalizedAmount.toFixed(2),
        };
    });

    return {
        bankLoanId,
        bankProfileId: drawdown.bankProfileId,
        ...computeFundSettlementSummary({
            allocations: normalizedAllocations,
            loans: allocatedLoans,
            borrowerTransactions,
            bankRepayments,
            rollovers: [
                ...incomingRollovers.map((row) => ({ amount: row.amount, direction: "in" as const, entryType: row.entryType })),
                ...outgoingRollovers.map((row) => ({ amount: row.amount, direction: "out" as const, entryType: row.entryType })),
            ],
            outstandingInterest: drawdown.outstandingInterest,
            outstandingFees: drawdown.outstandingFees,
            outstandingPenalties: drawdown.outstandingPenalties,
        }),
    };
}

export async function getLoanProfitabilitySummary(tenantId: string, loanId: number) {
    const loan = await db.query.loans.findFirst({
        where: and(eq(loans.id, loanId), eq(loans.tenantId, tenantId)),
    });

    if (!loan) {
        return null;
    }

    const allLoanAllocations = await db.select().from(loanFundingAllocations).where(
        and(
            eq(loanFundingAllocations.tenantId, tenantId),
            eq(loanFundingAllocations.loanId, loanId),
        )
    );

    const netAllocationsByDrawdown = new Map<number, number>();
    const netAllocationsByProfile = new Map<number, number>();
    for (const row of allLoanAllocations) {
        const amount = Number(row.allocatedAmount || 0);
        if (row.bankLoanId) {
            netAllocationsByDrawdown.set(row.bankLoanId, (netAllocationsByDrawdown.get(row.bankLoanId) ?? 0) + amount);
        }
        if (row.bankProfileId) {
            netAllocationsByProfile.set(row.bankProfileId, (netAllocationsByProfile.get(row.bankProfileId) ?? 0) + amount);
        }
    }

    const positiveDrawdownIds = Array.from(netAllocationsByDrawdown.entries())
        .filter(([, amount]) => amount > 0)
        .map(([id]) => id);

    const drawdowns = positiveDrawdownIds.length === 0
        ? []
        : await db.select().from(bankLoans).where(
            and(
                eq(bankLoans.tenantId, tenantId),
                inArray(bankLoans.id, positiveDrawdownIds),
            )
        );

    const peerAllocations = positiveDrawdownIds.length === 0
        ? []
        : await db.select().from(loanFundingAllocations).where(
            and(
                eq(loanFundingAllocations.tenantId, tenantId),
                inArray(loanFundingAllocations.bankLoanId, positiveDrawdownIds),
            )
        );

    const drawdownNetAllocatedTotals = new Map<number, number>();
    for (const row of peerAllocations) {
        if (!row.bankLoanId) continue;
        drawdownNetAllocatedTotals.set(row.bankLoanId, (drawdownNetAllocatedTotals.get(row.bankLoanId) ?? 0) + Number(row.allocatedAmount || 0));
    }

    const borrowerTransactions = await db.select({
        loanId: transactions.loanId,
        principalComponent: transactions.principalComponent,
        interestComponent: transactions.interestComponent,
        feeComponent: transactions.feeComponent,
        penaltyComponent: transactions.penaltyComponent,
    }).from(transactions).where(
        and(
            eq(transactions.tenantId, tenantId),
            eq(transactions.loanId, loanId),
        )
    );

    const fundedPrincipal = Array.from(netAllocationsByDrawdown.values()).reduce((sum, amount) => sum + Math.max(0, amount), 0);
    const fundingShare = Number(loan.principalAmount) > 0
        ? Math.min(1, fundedPrincipal / Number(loan.principalAmount))
        : 0;

    let allocatedBankInterestPaid = 0;
    let allocatedBankFeesPaid = 0;
    let allocatedBankVatPaid = 0;
    let allocatedBankPenaltiesPaid = 0;
    let allocatedOutstandingCost = 0;

    const fundingComposition = await Promise.all(drawdowns.map(async (drawdown) => {
        const netAllocated = Math.max(0, netAllocationsByDrawdown.get(drawdown.id) ?? 0);
        const totalAllocatedOnDrawdown = Math.max(
            0,
            drawdownNetAllocatedTotals.get(drawdown.id) ?? 0
        );
        const shareOfDrawdown = totalAllocatedOnDrawdown > 0
            ? Math.min(1, netAllocated / totalAllocatedOnDrawdown)
            : Math.min(1, netAllocated / Math.max(Number(drawdown.amount || 0), 1));

        const drawdownRepayments = await db.select({
            principalComponent: bankLoanRepayments.principalComponent,
            interestComponent: bankLoanRepayments.interestComponent,
            feeComponent: bankLoanRepayments.feeComponent,
            vatComponent: bankLoanRepayments.vatComponent,
            penaltyComponent: bankLoanRepayments.penaltyComponent,
        }).from(bankLoanRepayments).where(
            and(
                eq(bankLoanRepayments.tenantId, tenantId),
                eq(bankLoanRepayments.bankLoanId, drawdown.id),
            )
        );

        const drawdownBankInterestPaid = drawdownRepayments.reduce((sum, row) => sum + Number(row.interestComponent || 0), 0) * shareOfDrawdown;
        const drawdownBankFeesPaid = drawdownRepayments.reduce((sum, row) => sum + Number(row.feeComponent || 0), 0) * shareOfDrawdown;
        const drawdownBankVatPaid = drawdownRepayments.reduce((sum, row) => sum + Number(row.vatComponent || 0), 0) * shareOfDrawdown;
        const drawdownBankPenaltiesPaid = drawdownRepayments.reduce((sum, row) => sum + Number(row.penaltyComponent || 0), 0) * shareOfDrawdown;
        const outstandingCostAllocated =
            (Number(drawdown.outstandingInterest ?? 0) +
                Number(drawdown.outstandingFees ?? 0) +
                Number(drawdown.outstandingPenalties ?? 0)) * shareOfDrawdown;

        allocatedBankInterestPaid += drawdownBankInterestPaid;
        allocatedBankFeesPaid += drawdownBankFeesPaid;
        allocatedBankVatPaid += drawdownBankVatPaid;
        allocatedBankPenaltiesPaid += drawdownBankPenaltiesPaid;
        allocatedOutstandingCost += outstandingCostAllocated;

        return {
            bankLoanId: drawdown.id,
            bankProfileId: drawdown.bankProfileId,
            netAllocatedPrincipal: Number(netAllocated.toFixed(2)),
            shareOfLoanPrincipal: Number((Number(loan.principalAmount) > 0 ? netAllocated / Number(loan.principalAmount) : 0).toFixed(4)),
            shareOfDrawdown: Number(shareOfDrawdown.toFixed(4)),
            estimatedBankInterestPaid: Number(drawdownBankInterestPaid.toFixed(2)),
            estimatedBankFeesPaid: Number(drawdownBankFeesPaid.toFixed(2)),
            estimatedBankVatPaid: Number(drawdownBankVatPaid.toFixed(2)),
            estimatedBankPenaltiesPaid: Number(drawdownBankPenaltiesPaid.toFixed(2)),
            outstandingCostAllocated: Number(outstandingCostAllocated.toFixed(2)),
        };
    }));

    const borrowerInterestCollected = borrowerTransactions.reduce((sum, row) => sum + Number(row.interestComponent || 0), 0) * fundingShare;
    const borrowerFeesCollected = borrowerTransactions.reduce((sum, row) => sum + Number(row.feeComponent || 0), 0) * fundingShare;
    const borrowerPenaltiesCollected = borrowerTransactions.reduce((sum, row) => sum + Number(row.penaltyComponent || 0), 0) * fundingShare;
    const borrowerRevenueCollected = borrowerInterestCollected + borrowerFeesCollected + borrowerPenaltiesCollected;
    const fundCostPaid = allocatedBankInterestPaid + allocatedBankFeesPaid + allocatedBankVatPaid + allocatedBankPenaltiesPaid;
    const unrealizedBorrowerRevenue = (Number(loan.outstandingInterest ?? 0) + Number(loan.outstandingFees ?? 0)) * fundingShare;
    const realizedSpread = borrowerRevenueCollected - fundCostPaid;
    const unrealizedSpread = unrealizedBorrowerRevenue - allocatedOutstandingCost;
    const realizedRoiPercent = fundedPrincipal > 0 ? (realizedSpread / fundedPrincipal) * 100 : 0;

    return {
        loanId,
        principalAmount: Number(Number(loan.principalAmount).toFixed(2)),
        fundedPrincipal: Number(fundedPrincipal.toFixed(2)),
        unallocatedPrincipalGap: Number(Math.max(0, Number(loan.principalAmount) - fundedPrincipal).toFixed(2)),
        borrowerRevenueCollected: Number(borrowerRevenueCollected.toFixed(2)),
        fundCostPaid: Number(fundCostPaid.toFixed(2)),
        realizedSpread: Number(realizedSpread.toFixed(2)),
        unrealizedSpread: Number(unrealizedSpread.toFixed(2)),
        realizedRoiPercent: Number(realizedRoiPercent.toFixed(2)),
        estimatedOutstandingFundingCost: Number(allocatedOutstandingCost.toFixed(2)),
        fundingShare: Number(fundingShare.toFixed(4)),
        fundingComposition,
        profileFundingComposition: Array.from(netAllocationsByProfile.entries()).map(([bankProfileId, amount]) => ({
            bankProfileId,
            netAllocatedPrincipal: Number(amount.toFixed(2)),
        })),
    };
}
