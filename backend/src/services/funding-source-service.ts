import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { bankLoans, bankProfiles, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

type FundingProfile = Pick<typeof bankProfiles.$inferSelect,
    "id" | "publicId" | "name" | "type" | "providerName" | "status" | "creditLimit" | "accountingMode" | "reinvestProfitMode">;
type FundingDrawdown = Pick<typeof bankLoans.$inferSelect,
    "id" | "publicId" | "bankProfileId" | "amount" | "outstandingPrincipal" | "outstandingInterest" | "outstandingFees"
    | "outstandingPenalties" | "interestRate" | "startDate" | "termMonths" | "status">;

function optionalMoney(value: string | null) {
    return value === null ? null : serializeMoney(value);
}

export function presentFundingSources(profiles: FundingProfile[], drawdowns: FundingDrawdown[]) {
    return {
        profiles: profiles.map((profile) => ({
            publicId: profile.publicId,
            name: profile.name,
            type: profile.type,
            providerName: profile.providerName,
            status: profile.status,
            creditLimit: optionalMoney(profile.creditLimit),
            accountingMode: profile.accountingMode,
            reinvestProfitMode: profile.reinvestProfitMode,
            drawdowns: drawdowns.filter((drawdown) => drawdown.bankProfileId === profile.id).map((drawdown) => ({
                publicId: drawdown.publicId,
                amount: serializeMoney(drawdown.amount),
                outstandingPrincipal: optionalMoney(drawdown.outstandingPrincipal),
                outstandingInterest: optionalMoney(drawdown.outstandingInterest),
                outstandingFees: optionalMoney(drawdown.outstandingFees),
                outstandingPenalties: optionalMoney(drawdown.outstandingPenalties),
                interestRate: optionalMoney(drawdown.interestRate),
                startDate: drawdown.startDate,
                termMonths: drawdown.termMonths,
                status: drawdown.status,
            })),
        })),
    };
}

export async function listFundingSources(ctx: CommandContext, input: { status?: "active" | "closed" | "all" } = {}) {
    const actor = await db.query.users.findFirst({ where: and(
        eq(users.id, ctx.actorUserId ?? -1),
        eq(users.tenantId, ctx.tenantId),
    ) });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    if (!canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        throw new DomainError("FORBIDDEN", "Funding sources require tenant-wide access", 403);
    }
    const status = input.status && input.status !== "all" ? input.status : undefined;
    const profileConditions = [eq(bankProfiles.tenantId, ctx.tenantId)];
    if (status) profileConditions.push(eq(bankProfiles.status, status));
    const profileRows = await db.select().from(bankProfiles).where(and(...profileConditions));
    if (profileRows.length === 0) return { profiles: [] };
    const drawdownConditions = [
        eq(bankLoans.tenantId, ctx.tenantId),
        inArray(bankLoans.bankProfileId, profileRows.map((profile) => profile.id)),
    ];
    if (status) drawdownConditions.push(eq(bankLoans.status, status));
    const drawdownRows = await db.select().from(bankLoans).where(and(...drawdownConditions));
    return presentFundingSources(profileRows, drawdownRows);
}
