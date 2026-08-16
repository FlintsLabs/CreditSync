import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowers, intermediaries, loanCommissionParticipants, loans, paymentIntakes, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import {
    addLoanCommissionParticipant,
    endLoanCommissionParticipant,
    listLoanCommissionParticipants,
    previewLoanCommission,
    updateLoanCommissionParticipant,
} from "./loan-commission-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, payment_intermediary_attributions, loan_commission_participants, transactions, intermediaries, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seedTenant(tenantId: string, suffix: string) {
    const actor = await db.insert(users).values({ tenantId, email: `${suffix}@commission.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: `Borrower ${suffix}` }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({ tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "1000.00", interestRate: "0.00", repaymentType: "floating", status: "active" }).returning().then((rows) => rows[0]!);
    const intermediary = await db.insert(intermediaries).values({ tenantId, ownerUserId: actor.id, name: `Agent ${suffix}`, normalizedName: `agent-${suffix}`, createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
    return { actor, loan, intermediary };
}

function ctx(actor: typeof users.$inferSelect, idempotencyKey?: string): CommandContext {
    return { tenantId: actor.tenantId, actorUserId: actor.id, actorSource: "web", requestId: `req-${idempotencyKey ?? "read"}`, correlationId: `corr-${idempotencyKey ?? "read"}`, idempotencyKey };
}

describe("loan commission participant ledger", () => {
    if (integrationEnabled) beforeEach(resetTables);

    integrationTest("enforces tenant-scoped participants and a maximum overlapping rate of 100 percent", async () => {
        const seeded = await seedTenant("commission-a", "a");
        const second = await db.insert(intermediaries).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, name: "Agent B", normalizedName: "agent-b", createdByUserId: seeded.actor.id, updatedByUserId: seeded.actor.id }).returning().then((rows) => rows[0]!);
        const foreign = await seedTenant("commission-b", "foreign");
        const effectiveFrom = "2026-08-01T00:00:00.000Z";

        await addLoanCommissionParticipant(ctx(seeded.actor, "add-a"), { loanPublicId: seeded.loan.publicId, intermediaryPublicId: seeded.intermediary.publicId, commissionRate: "30.00", role: "collector", effectiveFrom });
        await addLoanCommissionParticipant(ctx(seeded.actor, "add-b"), { loanPublicId: seeded.loan.publicId, intermediaryPublicId: second.publicId, commissionRate: "20.00", role: "introducer", effectiveFrom });
        await expect(addLoanCommissionParticipant(ctx(seeded.actor, "too-much"), { loanPublicId: seeded.loan.publicId, intermediaryPublicId: second.publicId, commissionRate: "60.00", role: "collector", effectiveFrom })).rejects.toMatchObject({ code: "COMMISSION_RATE_OVERLAP", status: 409 });
        await expect(addLoanCommissionParticipant(ctx(seeded.actor, "foreign-agent"), { loanPublicId: seeded.loan.publicId, intermediaryPublicId: foreign.intermediary.publicId, commissionRate: "1.00", role: "collector", effectiveFrom })).rejects.toMatchObject({ code: "INTERMEDIARY_NOT_FOUND" });
        await expect(addLoanCommissionParticipant(ctx(seeded.actor, "foreign-loan"), { loanPublicId: foreign.loan.publicId, intermediaryPublicId: seeded.intermediary.publicId, commissionRate: "1.00", role: "collector", effectiveFrom })).rejects.toMatchObject({ code: "LOAN_NOT_FOUND" });
    });

    integrationTest("updates and ends by appending versions without changing prior rows", async () => {
        const seeded = await seedTenant("commission-version", "version");
        const added = await addLoanCommissionParticipant(ctx(seeded.actor, "add"), { loanPublicId: seeded.loan.publicId, intermediaryPublicId: seeded.intermediary.publicId, commissionRate: "30.00", role: "collector", effectiveFrom: "2026-08-01T00:00:00.000Z" });
        const original = await db.query.loanCommissionParticipants.findFirst({ where: eq(loanCommissionParticipants.publicId, added.publicId) });
        const updated = await updateLoanCommissionParticipant(ctx(seeded.actor, "update"), { participantPublicId: added.publicId, commissionRate: "25.00", role: "collector", effectiveFrom: "2026-08-10T00:00:00.000Z", note: "new agreement" });
        const ended = await endLoanCommissionParticipant(ctx(seeded.actor, "end"), { participantPublicId: updated.publicId, effectiveTo: "2026-08-20T00:00:00.000Z", reason: "agreement ended" });

        expect(await db.query.loanCommissionParticipants.findFirst({ where: eq(loanCommissionParticipants.publicId, added.publicId) })).toEqual(original);
        expect(updated).toMatchObject({ commissionRate: "25.00", status: "active", previousParticipantPublicId: added.publicId });
        expect(ended).toMatchObject({ commissionRate: "25.00", status: "ended", previousParticipantPublicId: updated.publicId, effectiveTo: "2026-08-20T00:00:00.000Z" });
        expect(await db.select().from(loanCommissionParticipants)).toHaveLength(3);
        expect(await listLoanCommissionParticipants(ctx(seeded.actor), seeded.loan.publicId)).toEqual([ended]);

        const audit = await db.query.auditLogs.findFirst({ where: eq(auditLogs.publicId, ended.auditPublicId) });
        expect(audit).toMatchObject({ tenantId: seeded.actor.tenantId, actorUserId: seeded.actor.id, actorSource: "web", requestId: "req-end", correlationId: "corr-end", entityId: ended.publicId, action: "ended" });
        await expect(db.update(loanCommissionParticipants).set({ note: "mutated" }).where(eq(loanCommissionParticipants.publicId, added.publicId))).rejects.toThrow(/append-only/);
        await expect(db.delete(loanCommissionParticipants).where(eq(loanCommissionParticipants.publicId, added.publicId))).rejects.toThrow(/append-only/);
    });

    integrationTest("authorizes idempotent participant replay and requires strict ISO timestamps", async () => {
        const seeded = await seedTenant("commission-replay", "replay");
        const peer = await db.insert(users).values({ tenantId: seeded.actor.tenantId, email: "peer@commission.test", role: "collector" }).returning().then((rows) => rows[0]!);
        const input = { loanPublicId: seeded.loan.publicId, intermediaryPublicId: seeded.intermediary.publicId, commissionRate: "30.00", role: "collector", effectiveFrom: "2026-08-01T00:00:00.000Z" };
        const first = await addLoanCommissionParticipant(ctx(seeded.actor, "scoped-replay"), input);

        await expect(addLoanCommissionParticipant(ctx(peer, "scoped-replay"), input)).rejects.toMatchObject({ code: "COMMISSION_PARTICIPANT_NOT_FOUND", status: 404 });
        expect((await addLoanCommissionParticipant(ctx(seeded.actor, "scoped-replay"), input)).publicId).toBe(first.publicId);
        const updateInput = { participantPublicId: first.publicId, commissionRate: "25.00", role: "collector", effectiveFrom: "2026-08-10T00:00:00.000Z" };
        const updated = await updateLoanCommissionParticipant(ctx(seeded.actor, "scoped-update-replay"), updateInput);
        await expect(updateLoanCommissionParticipant(ctx(peer, "scoped-update-replay"), updateInput)).rejects.toMatchObject({ code: "COMMISSION_PARTICIPANT_NOT_FOUND", status: 404 });
        const endInput = { participantPublicId: updated.publicId, effectiveTo: "2026-08-20T00:00:00.000Z", reason: "agreement ended" };
        await endLoanCommissionParticipant(ctx(seeded.actor, "scoped-end-replay"), endInput);
        await expect(endLoanCommissionParticipant(ctx(peer, "scoped-end-replay"), endInput)).rejects.toMatchObject({ code: "COMMISSION_PARTICIPANT_NOT_FOUND", status: 404 });
        await expect(addLoanCommissionParticipant(ctx(seeded.actor, "invalid-date"), { ...input, effectiveFrom: "August 1, 2026" })).rejects.toMatchObject({ code: "INVALID_COMMISSION_DATE", status: 400 });
        await expect(addLoanCommissionParticipant(ctx(seeded.actor, "invalid-zone"), { ...input, effectiveFrom: "2026-08-01T00:00:00" })).rejects.toMatchObject({ code: "INVALID_COMMISSION_DATE", status: 400 });
        await expect(addLoanCommissionParticipant(ctx(seeded.actor, "invalid-calendar"), { ...input, effectiveFrom: "2026-02-30T00:00:00.000Z" })).rejects.toMatchObject({ code: "INVALID_COMMISSION_DATE", status: 400 });
    });

    integrationTest("previews exact commission from signed interest components only", async () => {
        const seeded = await seedTenant("commission-preview", "preview");
        await addLoanCommissionParticipant(ctx(seeded.actor, "add"), { loanPublicId: seeded.loan.publicId, intermediaryPublicId: seeded.intermediary.publicId, commissionRate: "30.00", role: "collector", effectiveFrom: "2026-08-01T00:00:00.000Z" });
        const paymentA = await db.insert(transactions).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, loanId: seeded.loan.id, amount: "350.25", principalComponent: "100.00", interestComponent: "200.25", feeComponent: "40.00", penaltyComponent: "10.00", idempotencyKey: "payment-a", postedAt: new Date("2026-08-11T00:00:00.000Z") }).returning().then((rows) => rows[0]!);
        const paymentB = await db.insert(transactions).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, loanId: seeded.loan.id, amount: "99.75", interestComponent: "99.75", idempotencyKey: "payment-b", postedAt: new Date("2026-08-12T00:00:00.000Z") }).returning().then((rows) => rows[0]!);
        const reversal = await db.insert(transactions).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, loanId: seeded.loan.id, amount: "-99.75", interestComponent: "-99.75", entryType: "reversal", reversedTransactionId: paymentB.id, idempotencyKey: "payment-b-reversal", postedAt: new Date("2026-08-13T00:00:00.000Z") }).returning().then((rows) => rows[0]!);

        const original = await previewLoanCommission(ctx(seeded.actor), { loanPublicId: seeded.loan.publicId, paymentPublicIds: [paymentA.publicId, paymentB.publicId] });
        const compensating = await previewLoanCommission(ctx(seeded.actor), { loanPublicId: seeded.loan.publicId, paymentPublicIds: [reversal.publicId] });
        expect(original).toMatchObject({ interestAmount: "300.00", totalCommission: "90.00", participants: [{ commissionAmount: "90.00" }] });
        expect(compensating).toMatchObject({ interestAmount: "-99.75", totalCommission: "-29.93", participants: [{ commissionAmount: "-29.93" }] });
        expect((await previewLoanCommission(ctx(seeded.actor), { loanPublicId: seeded.loan.publicId, paymentPublicIds: [paymentA.publicId, paymentB.publicId] })).totalCommission).toBe("90.00");
    });

    integrationTest("rejects transaction rows that are not canonical posted payments", async () => {
        const seeded = await seedTenant("commission-posted-only", "posted-only");
        await addLoanCommissionParticipant(ctx(seeded.actor, "add"), { loanPublicId: seeded.loan.publicId, intermediaryPublicId: seeded.intermediary.publicId, commissionRate: "30.00", role: "collector", effectiveFrom: "2026-08-01T00:00:00.000Z" });
        const draftIntake = await db.insert(paymentIntakes).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, amount: "100.00", status: "draft", originLoanId: seeded.loan.id }).returning().then((rows) => rows[0]!);
        const intakeLinkedDraft = await db.insert(transactions).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, loanId: seeded.loan.id, paymentIntakeId: draftIntake.id, amount: "100.00", interestComponent: "100.00", type: "repayment", entryType: "repayment", idempotencyKey: "draft-intake-transaction" }).returning().then((rows) => rows[0]!);
        const nonPayment = await db.insert(transactions).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, loanId: seeded.loan.id, amount: "100.00", interestComponent: "100.00", type: "draft", entryType: "repayment", idempotencyKey: "non-payment-transaction" }).returning().then((rows) => rows[0]!);

        await expect(previewLoanCommission(ctx(seeded.actor), { loanPublicId: seeded.loan.publicId, paymentPublicIds: [intakeLinkedDraft.publicId] })).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND", status: 404 });
        await expect(previewLoanCommission(ctx(seeded.actor), { loanPublicId: seeded.loan.publicId, paymentPublicIds: [nonPayment.publicId] })).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND", status: 404 });
    });
});
