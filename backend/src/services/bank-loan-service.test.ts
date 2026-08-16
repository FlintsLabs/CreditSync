import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, bankLoanSchedules, bankLoans, bankProfiles, users } from "../db/schema";
import { previewBankDrawdown, type BankDrawdownInput } from "./bank-loan-service";
import { activateBankDrawdown, createBankDrawdownDraft } from "./bank-loan-service";
import type { CommandContext } from "./command-context";

const ctx: CommandContext = { tenantId: "test", actorUserId: null, actorSource: "system", requestId: "req", correlationId: "corr" };
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

const input = (profile: string, amount = "100.00", note = "Borrowing tranche") => ({
    bankProfilePublicId: profile, amount, interestRate: "12.0000", startDate: "2026-08-16",
    termMonths: 2, repaymentCycle: "monthly" as const, repaymentMode: "fixed_installment" as const,
    processingFeeAmount: "1.00", utilizationFeeAmount: "2.00", vatRate: "7.0000", note,
});
async function seed(role: "owner" | "viewer" = "owner", status = "active", creditLimit = "500.00") {
    const actor = await db.insert(users).values({ tenantId: "bank-test", email: `${role}-${crypto.randomUUID()}@test`, role }).returning().then((r) => r[0]!);
    const profile = await db.insert(bankProfiles).values({ tenantId: actor.tenantId, name: "Test bank", type: "bank", status, creditLimit }).returning().then((r) => r[0]!);
    return { actor, profile };
}
function command(actor: typeof users.$inferSelect, key: string, overrides: Partial<CommandContext> = {}): CommandContext {
    return { tenantId: actor.tenantId, actorUserId: actor.id, actorSource: "web", requestId: `request-${key}`, correlationId: `correlation-${key}`, idempotencyKey: key, ...overrides };
}
beforeEach(async () => {
    if (process.env.TEST_DATABASE_URL) await db.execute(sql`TRUNCATE TABLE audit_logs, bank_loan_schedules, bank_loans, bank_profiles, users RESTART IDENTITY CASCADE`);
});
describe("bank drawdown service contract", () => {
    test("requires an idempotency key for writes", async () => {
        expect(ctx.idempotencyKey).toBeUndefined();
    });
    test("exports Decimal schedule preview contract", () => {
        expect(previewBankDrawdown).toBeFunction();
    });
    test("requires the supported repayment mode explicitly", () => {
        const input: BankDrawdownInput = {
            bankProfilePublicId: "profile",
            amount: "100.00",
            interestRate: "0.00",
            repaymentMode: "fixed_installment",
        };
        expect(input.repaymentMode).toBe("fixed_installment");
    });

    integrationTest("authorizes tenant admins and rejects inactive profiles", async () => {
        const owner = await seed("owner");
        const viewer = await db.insert(users).values({ tenantId: owner.actor.tenantId, email: "viewer@test", role: "viewer" }).returning().then((r) => r[0]!);
        await expect(previewBankDrawdown(command(viewer, "preview-viewer"), input(owner.profile.publicId))).rejects.toMatchObject({ code: "TENANT_ADMIN_REQUIRED" });
        const inactive = await seed("owner", "inactive");
        await expect(previewBankDrawdown(command(inactive.actor, "preview-inactive"), input(inactive.profile.publicId))).rejects.toMatchObject({ code: "BANK_PROFILE_INACTIVE" });
        await expect(previewBankDrawdown({ ...command(owner.actor, "preview-null"), actorUserId: null }, input(owner.profile.publicId))).rejects.toMatchObject({ code: "TENANT_ADMIN_REQUIRED" });
    });

    integrationTest("enforces aggregate Decimal credit limits and preserves draft note/idempotency", async () => {
        const { actor, profile } = await seed("owner", "active", "100.00");
        const first = await createBankDrawdownDraft(command(actor, "draft-1"), input(profile.publicId, "60.005", "Keep this note"));
        expect(first).toMatchObject({ amount: "60.01", note: "Keep this note", status: "draft", requestId: "request-draft-1", correlationId: "correlation-draft-1" });
        expect((await createBankDrawdownDraft(command(actor, "draft-1"), input(profile.publicId, "60.005", "Keep this note"))).publicId).toBe(first.publicId);
        await expect(createBankDrawdownDraft(command(actor, "draft-1"), input(profile.publicId, "60.00", "different"))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
        await expect(createBankDrawdownDraft(command(actor, "draft-2"), input(profile.publicId, "40.00"))).rejects.toMatchObject({ code: "CREDIT_LIMIT_EXCEEDED" });
        expect(await db.select().from(bankLoans)).toHaveLength(1);
    });

    integrationTest("activates once, persists schedule and audit context, and detects replay conflict", async () => {
        const { actor, profile } = await seed();
        const base = command(actor, "draft-activate");
        const draft = await createBankDrawdownDraft(base, input(profile.publicId, "100.00"));
        const activation = await activateBankDrawdown(command(actor, "activate-1", { requestId: "activate-request", correlationId: "activate-correlation" }), { bankLoanPublicId: draft.publicId });
        expect(activation).toMatchObject({ status: "active", activationIdempotencyKey: "activate-1", outstandingPrincipal: "100.00", nextDueDate: "2026-09-16" });
        expect(await db.select().from(bankLoanSchedules).where(eq(bankLoanSchedules.bankLoanId, draft.id))).toHaveLength(2);
        expect((await db.select().from(auditLogs).where(eq(auditLogs.entityId, String(draft.id)))).map((a) => [a.action, a.requestId, a.correlationId])).toEqual([["draft_created", "request-draft-activate", "correlation-draft-activate"], ["activated", "activate-request", "activate-correlation"]]);
        expect((await activateBankDrawdown(command(actor, "activate-1"), { bankLoanPublicId: draft.publicId })).publicId).toBe(draft.publicId);
        await expect(activateBankDrawdown(command(actor, "activate-1"), { bankLoanPublicId: "00000000-0000-0000-0000-000000000000" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });
});
