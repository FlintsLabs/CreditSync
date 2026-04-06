import { and, eq, inArray } from "drizzle-orm";
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

interface AllocationLike {
    loanId: number;
    allocatedAmount: string;
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
    borrowerInterestCollected: number;
    borrowerFeesCollected: number;
    borrowerPenaltiesCollected: number;
    bankInterestPaid: number;
    bankFeesPaid: number;
    bankVatPaid: number;
    bankPenaltiesPaid: number;
    realizedSpread: number;
    unrealizedSpread: number;
    surplusBalance: number;
    deficitBalance: number;
    carryForwardAvailable: number;
}

export function deriveProfitabilityMetrics(summary: SettlementSummaryLike, deployedPrincipal: number) {
    const borrowerRevenueCollected =
        summary.borrowerInterestCollected +
        summary.borrowerFeesCollected +
        summary.borrowerPenaltiesCollected;
    const fundCostPaid =
        summary.bankInterestPaid +
        summary.bankFeesPaid +
        summary.bankVatPaid +
        summary.bankPenaltiesPaid;
    const netCashPosition = summary.surplusBalance - summary.deficitBalance;
    const realizedRoiPercent = deployedPrincipal > 0
        ? (summary.realizedSpread / deployedPrincipal) * 100
        : 0;

    return {
        borrowerRevenueCollected: Number(borrowerRevenueCollected.toFixed(2)),
        fundCostPaid: Number(fundCostPaid.toFixed(2)),
        realizedSpread: Number(summary.realizedSpread.toFixed(2)),
        unrealizedSpread: Number(summary.unrealizedSpread.toFixed(2)),
        deployedPrincipal: Number(deployedPrincipal.toFixed(2)),
        netCashPosition: Number(netCashPosition.toFixed(2)),
        realizedRoiPercent: Number(realizedRoiPercent.toFixed(2)),
        carryForwardAvailable: Number(summary.carryForwardAvailable.toFixed(2)),
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
    const allocationShareByLoan = new Map<number, number[]>();

    for (const allocation of input.allocations) {
        const loan = loanMap.get(allocation.loanId);
        if (!loan) continue;
        const principal = Number(loan.principalAmount || 0);
        if (principal <= 0) continue;
        const share = Number(allocation.allocatedAmount || 0) / principal;
        allocationShareByLoan.set(allocation.loanId, [...(allocationShareByLoan.get(allocation.loanId) ?? []), share]);
    }

    let borrowerPrincipalCollected = 0;
    let borrowerInterestCollected = 0;
    let borrowerFeesCollected = 0;
    let borrowerPenaltiesCollected = 0;

    for (const tx of input.borrowerTransactions) {
        const shares = allocationShareByLoan.get(tx.loanId) ?? [];
        const totalShare = Math.min(1, shares.reduce((sum, share) => sum + share, 0));
        borrowerPrincipalCollected += Number(tx.principalComponent || 0) * totalShare;
        borrowerInterestCollected += Number(tx.interestComponent || 0) * totalShare;
        borrowerFeesCollected += Number(tx.feeComponent || 0) * totalShare;
        borrowerPenaltiesCollected += Number(tx.penaltyComponent || 0) * totalShare;
    }

    const bankPrincipalPaid = input.bankRepayments.reduce((sum, row) => sum + Number(row.principalComponent || 0), 0);
    const bankInterestPaid = input.bankRepayments.reduce((sum, row) => sum + Number(row.interestComponent || 0), 0);
    const bankFeesPaid = input.bankRepayments.reduce((sum, row) => sum + Number(row.feeComponent || 0), 0);
    const bankVatPaid = input.bankRepayments.reduce((sum, row) => sum + Number(row.vatComponent || 0), 0);
    const bankPenaltiesPaid = input.bankRepayments.reduce((sum, row) => sum + Number(row.penaltyComponent || 0), 0);

    const rolloverIn = (input.rollovers ?? [])
        .filter((row) => row.direction === "in")
        .reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const rolloverOut = (input.rollovers ?? [])
        .filter((row) => row.direction === "out")
        .reduce((sum, row) => sum + Number(row.amount || 0), 0);

    const realizedSpread =
        borrowerInterestCollected +
        borrowerFeesCollected +
        borrowerPenaltiesCollected -
        bankInterestPaid -
        bankFeesPaid -
        bankVatPaid -
        bankPenaltiesPaid;

    const currentNetCash =
        borrowerPrincipalCollected +
        borrowerInterestCollected +
        borrowerFeesCollected +
        borrowerPenaltiesCollected -
        bankPrincipalPaid -
        bankInterestPaid -
        bankFeesPaid -
        bankVatPaid -
        bankPenaltiesPaid +
        rolloverIn -
        rolloverOut;

    const remainingBorrowerInterest = input.allocations.reduce((sum, allocation) => {
        const loan = loanMap.get(allocation.loanId);
        if (!loan) return sum;
        const principal = Number(loan.principalAmount || 0);
        if (principal <= 0) return sum;
        const share = Number(allocation.allocatedAmount || 0) / principal;
        return sum + (Number(loan.outstandingInterest || 0) + Number(loan.outstandingFees || 0)) * share;
    }, 0);

    const remainingBankCost =
        Number(input.outstandingInterest || 0) +
        Number(input.outstandingFees || 0) +
        Number(input.outstandingPenalties || 0);

    const unrealizedSpread = remainingBorrowerInterest - remainingBankCost;
    const surplusBalance = Math.max(0, currentNetCash);
    const deficitBalance = Math.max(0, currentNetCash * -1);

    const borrowerRevenueCollected =
        borrowerInterestCollected +
        borrowerFeesCollected +
        borrowerPenaltiesCollected;
    const fundCostPaid =
        bankInterestPaid +
        bankFeesPaid +
        bankVatPaid +
        bankPenaltiesPaid;

    return {
        borrowerPrincipalCollected: Number(borrowerPrincipalCollected.toFixed(2)),
        borrowerInterestCollected: Number(borrowerInterestCollected.toFixed(2)),
        borrowerFeesCollected: Number(borrowerFeesCollected.toFixed(2)),
        borrowerPenaltiesCollected: Number(borrowerPenaltiesCollected.toFixed(2)),
        borrowerRevenueCollected: Number(borrowerRevenueCollected.toFixed(2)),
        bankPrincipalPaid: Number(bankPrincipalPaid.toFixed(2)),
        bankInterestPaid: Number(bankInterestPaid.toFixed(2)),
        bankFeesPaid: Number(bankFeesPaid.toFixed(2)),
        bankVatPaid: Number(bankVatPaid.toFixed(2)),
        bankPenaltiesPaid: Number(bankPenaltiesPaid.toFixed(2)),
        fundCostPaid: Number(fundCostPaid.toFixed(2)),
        realizedSpread: Number(realizedSpread.toFixed(2)),
        unrealizedSpread: Number(unrealizedSpread.toFixed(2)),
        rolloverIn: Number(rolloverIn.toFixed(2)),
        rolloverOut: Number(rolloverOut.toFixed(2)),
        surplusBalance: Number(surplusBalance.toFixed(2)),
        deficitBalance: Number(deficitBalance.toFixed(2)),
        carryForwardAvailable: Number(Math.max(0, surplusBalance).toFixed(2)),
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
    const sourceAllocations = drawdownIds.length === 0
        ? []
        : await db.select().from(loanFundingAllocations).where(
            and(
                eq(loanFundingAllocations.tenantId, tenantId),
                inArray(loanFundingAllocations.bankLoanId, drawdownIds),
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

    const summary = computeFundSettlementSummary({
        allocations: normalizedAllocations,
        loans: allocatedLoans,
        borrowerTransactions,
        bankRepayments,
        rollovers: [
            ...incomingRollovers.map((row) => ({ amount: row.amount, direction: "in" as const, entryType: row.entryType })),
            ...outgoingRollovers.map((row) => ({ amount: row.amount, direction: "out" as const, entryType: row.entryType })),
        ],
        outstandingInterest: drawdowns.reduce((sum, row) => sum + Number(row.outstandingInterest ?? 0), 0).toFixed(2),
        outstandingFees: drawdowns.reduce((sum, row) => sum + Number(row.outstandingFees ?? 0), 0).toFixed(2),
        outstandingPenalties: drawdowns.reduce((sum, row) => sum + Number(row.outstandingPenalties ?? 0), 0).toFixed(2),
    });

    const poolCurrentBalance = ledgerEntries.reduce((sum, row) => {
        const amount = Number(row.amount);
        return row.entryType.endsWith("_out") ? sum - amount : sum + amount;
    }, 0);

    return {
        bankProfileId,
        drawdownCount: drawdowns.length,
        ...summary,
        poolCurrentBalance: Number(poolCurrentBalance.toFixed(2)),
        ownerSupportTotal: Number(incomingRollovers
            .filter((row) => row.entryType === "deficit_support")
            .reduce((sum, row) => sum + Number(row.amount), 0)
            .toFixed(2)),
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
