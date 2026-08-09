import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { bankLoanSchedules, bankLoans, bankProfiles, borrowers, loanSchedules, loans } from "../db/schema";
import { borrowerAccessFilters, type AuthenticatedUser, loanAccessFilters } from "./access";

export async function findBankProfileByPublicId(tenantId: string, publicId: string) {
    return await db.query.bankProfiles.findFirst({
        where: and(eq(bankProfiles.publicId, publicId), eq(bankProfiles.tenantId, tenantId)),
    });
}

export async function findBorrowerByPublicId(tenantId: string, publicId: string) {
    return await db.query.borrowers.findFirst({
        where: and(eq(borrowers.publicId, publicId), eq(borrowers.tenantId, tenantId)),
    });
}

export async function findAccessibleBorrowerByPublicId(user: AuthenticatedUser, publicId: string) {
    return await db.query.borrowers.findFirst({
        where: and(eq(borrowers.publicId, publicId), ...borrowerAccessFilters(user)),
    });
}

export async function findLoanByPublicId(tenantId: string, publicId: string) {
    return await db.query.loans.findFirst({
        where: and(eq(loans.publicId, publicId), eq(loans.tenantId, tenantId)),
    });
}

export async function findAccessibleLoanByPublicId(user: AuthenticatedUser, publicId: string) {
    return await db.query.loans.findFirst({
        where: and(eq(loans.publicId, publicId), ...loanAccessFilters(user)),
    });
}

export async function findBankLoanByPublicId(tenantId: string, publicId: string) {
    return await db.query.bankLoans.findFirst({
        where: and(eq(bankLoans.publicId, publicId), eq(bankLoans.tenantId, tenantId)),
    });
}

export async function findLoanScheduleByPublicId(tenantId: string, publicId: string) {
    return await db.query.loanSchedules.findFirst({
        where: and(eq(loanSchedules.publicId, publicId), eq(loanSchedules.tenantId, tenantId)),
    });
}

export async function findBankLoanScheduleByPublicId(tenantId: string, publicId: string) {
    return await db.query.bankLoanSchedules.findFirst({
        where: and(eq(bankLoanSchedules.publicId, publicId), eq(bankLoanSchedules.tenantId, tenantId)),
    });
}
