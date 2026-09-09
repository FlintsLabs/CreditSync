import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { bankLoans, bankProfiles, loanFundingAllocations, loans } from "../db/schema";
import { serializeSignedMoney } from "./loan-http-support";
import { getLoanProfitabilitySummary } from "../lib/fund-settlement";

export type FundingAllocationRow = typeof loanFundingAllocations.$inferSelect;

export async function presentFundingAllocation(row: FundingAllocationRow) {
    const [loan, bankProfile, bankLoan] = await Promise.all([
        db.query.loans.findFirst({ where: and(eq(loans.id, row.loanId), eq(loans.tenantId, row.tenantId)) }),
        row.bankProfileId === null ? null : db.query.bankProfiles.findFirst({ where: and(eq(bankProfiles.id, row.bankProfileId), eq(bankProfiles.tenantId, row.tenantId)) }),
        row.bankLoanId === null ? null : db.query.bankLoans.findFirst({ where: and(eq(bankLoans.id, row.bankLoanId), eq(bankLoans.tenantId, row.tenantId)) }),
    ]);
    return { id: row.publicId, publicId: row.publicId, loanPublicId: loan?.publicId ?? null, bankProfilePublicId: bankProfile?.publicId ?? null, bankLoanPublicId: bankLoan?.publicId ?? null, allocatedAmount: serializeSignedMoney(row.allocatedAmount), allocationDate: row.allocationDate, allocationType: row.allocationType, note: row.note, createdAt: row.createdAt };
}

export function isMutableFundingLoan(status: string | null) {
    return !["renewed", "canceled", "cancelled", "replaced", "reversed", "settled", "closed", "paid"].includes(status ?? "");
}

export function signedMoney(value: Decimal.Value) { return serializeSignedMoney(value); }

type LoanProfitabilitySummary = NonNullable<Awaited<ReturnType<typeof getLoanProfitabilitySummary>>>;
export async function presentLoanProfitability(tenantId: string, loanPublicId: string, summary: LoanProfitabilitySummary) {
    const fundingComposition = await Promise.all(summary.fundingComposition.map(async (item) => {
        const [bankLoan, bankProfile] = await Promise.all([db.query.bankLoans.findFirst({ where: and(eq(bankLoans.id, item.bankLoanId), eq(bankLoans.tenantId, tenantId)) }), item.bankProfileId === null ? null : db.query.bankProfiles.findFirst({ where: and(eq(bankProfiles.id, item.bankProfileId), eq(bankProfiles.tenantId, tenantId)) })]);
        return { bankLoanPublicId: bankLoan?.publicId ?? null, bankProfilePublicId: bankProfile?.publicId ?? null, netAllocatedPrincipal: serializeSignedMoney(item.netAllocatedPrincipal), shareOfLoanPrincipal: item.shareOfLoanPrincipal, shareOfDrawdown: item.shareOfDrawdown, estimatedBankInterestPaid: serializeSignedMoney(item.estimatedBankInterestPaid), estimatedBankFeesPaid: serializeSignedMoney(item.estimatedBankFeesPaid), estimatedBankVatPaid: serializeSignedMoney(item.estimatedBankVatPaid), estimatedBankPenaltiesPaid: serializeSignedMoney(item.estimatedBankPenaltiesPaid), outstandingCostAllocated: serializeSignedMoney(item.outstandingCostAllocated) };
    }));
    const profileFundingComposition = await Promise.all(summary.profileFundingComposition.map(async (item) => ({ bankProfilePublicId: (await db.query.bankProfiles.findFirst({ where: and(eq(bankProfiles.id, item.bankProfileId), eq(bankProfiles.tenantId, tenantId)) }))?.publicId ?? null, netAllocatedPrincipal: serializeSignedMoney(item.netAllocatedPrincipal) })));
    return { loanId: loanPublicId, loanPublicId, principalAmount: serializeSignedMoney(summary.principalAmount), fundedPrincipal: serializeSignedMoney(summary.fundedPrincipal), unallocatedPrincipalGap: serializeSignedMoney(summary.unallocatedPrincipalGap), borrowerRevenueCollected: serializeSignedMoney(summary.borrowerRevenueCollected), fundCostPaid: serializeSignedMoney(summary.fundCostPaid), realizedSpread: serializeSignedMoney(summary.realizedSpread), unrealizedSpread: serializeSignedMoney(summary.unrealizedSpread), realizedRoiPercent: summary.realizedRoiPercent, estimatedOutstandingFundingCost: serializeSignedMoney(summary.estimatedOutstandingFundingCost), fundingShare: summary.fundingShare, fundingComposition, profileFundingComposition };
}
