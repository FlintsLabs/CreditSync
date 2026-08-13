import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs,
    borrowers,
    intermediaries,
    intermediaryBankAccounts,
    loanIntermediaryAssignments,
    loans,
    users,
} from "../db/schema";
import type { CommandContext } from "./command-context";
import { createIntermediary } from "./intermediary-service";
import {
    assignIntermediaryToLoan,
    endIntermediaryAssignment,
    getIntermediaryProfile,
    listManagedLoans,
    saveIntermediaryBankAccount,
} from "./intermediary-profile-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, loan_intermediary_assignments, intermediary_bank_accounts,
        intermediaries, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seedActor(tenantId: string, suffix: string, role: "owner" | "manager" | "collector" | "viewer" = "owner") {
    return db.insert(users).values({ tenantId, email: `${suffix}@intermediary-profile.test`, role })
        .returning().then((rows) => rows[0]!);
}

async function seedLoan(actor: typeof users.$inferSelect, suffix: string, status = "active") {
    const borrower = await db.insert(borrowers).values({
        tenantId: actor.tenantId,
        ownerUserId: actor.id,
        name: `Borrower ${suffix}`,
    }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId: actor.tenantId,
        ownerUserId: actor.id,
        borrowerId: borrower.id,
        principalAmount: "5000.00",
        interestRate: "0.00",
        repaymentType: "floating",
        outstandingPrincipal: "4321.00",
        outstandingInterest: "12.00",
        outstandingFees: "3.00",
        status,
    }).returning().then((rows) => rows[0]!);
    return { borrower, loan };
}

function context(actor: typeof users.$inferSelect, idempotencyKey?: string): CommandContext {
    return {
        tenantId: actor.tenantId,
        actorUserId: actor.id,
        actorSource: "web",
        requestId: `req-${idempotencyKey ?? "read"}`,
        correlationId: `corr-${idempotencyKey ?? "read"}`,
        idempotencyKey,
    };
}

describe("intermediary profile, account, and assignment service", () => {
    if (integrationEnabled) beforeEach(resetTables);

    // Break caught: create ignores an exact confirmed alias and creates a duplicate intermediary identity.
    integrationTest("reuses a profile found by confirmed alias and exposes only reusable masked bank accounts", async () => {
        const actor = await seedActor("tenant-profile", "profile-owner");
        const original = await createIntermediary(context(actor), {
            name: "Somsri Collector",
            aliases: ["Cash Desk"],
            notes: "Confirmed in person",
        });

        const aliasReplay = await createIntermediary(context(actor), { name: "  cash-desk!! " });
        expect(aliasReplay.publicId).toBe(original.publicId);
        expect(await db.select().from(intermediaries)).toHaveLength(1);

        const first = await saveIntermediaryBankAccount(
            context(actor, "bank-save-1"),
            original.publicId,
            {
                bankCode: "KBANK",
                bankName: "Kasikornbank",
                accountName: "Somsri Collector",
                accountNumber: "123-4-56789-0",
                note: "Primary payout account",
            },
        );
        const replay = await saveIntermediaryBankAccount(
            context(actor, "bank-save-1"),
            original.publicId,
            {
                bankCode: "KBANK",
                bankName: "Kasikornbank",
                accountName: "Somsri Collector",
                accountNumber: "123-4-56789-0",
                note: "Primary payout account",
            },
        );
        const reused = await saveIntermediaryBankAccount(
            context(actor, "bank-save-2"),
            original.publicId,
            {
                bankCode: "KBANK",
                bankName: "Kasikorn Bank",
                accountName: "Somsri Collector",
                accountNumber: "1234567890",
                note: "Updated payout label",
            },
        );
        const replayAfterUpdate = await saveIntermediaryBankAccount(
            context(actor, "bank-save-1"),
            original.publicId,
            {
                bankCode: "KBANK",
                bankName: "Kasikornbank",
                accountName: "Somsri Collector",
                accountNumber: "123-4-56789-0",
                note: "Primary payout account",
            },
        );

        expect(first).toMatchObject({
            publicId: first.publicId,
            bankCode: "KBANK",
            bankName: "Kasikornbank",
            accountName: "Somsri Collector",
            maskedAccountNumber: "•••• 7890",
            status: "active",
        });
        expect(replay.publicId).toBe(first.publicId);
        expect(reused.publicId).toBe(first.publicId);
        expect(reused).toMatchObject({ bankName: "Kasikorn Bank", note: "Updated payout label" });
        expect(replayAfterUpdate).toEqual(first);
        for (const account of [first, replay, reused, replayAfterUpdate]) {
            expect(account).not.toHaveProperty("accountNumber");
            expect(account).not.toHaveProperty("accountNumberHash");
            expect(account).not.toHaveProperty("accountNumberLast4");
            expect(account).not.toHaveProperty("intermediaryId");
        }
        expect(await db.select().from(intermediaryBankAccounts)).toHaveLength(1);

        const profile = await getIntermediaryProfile(context(actor), original.publicId);
        expect(profile).toMatchObject({
            publicId: original.publicId,
            name: "Somsri Collector",
            aliases: ["Cash Desk"],
            bankAccounts: [{ publicId: first.publicId, maskedAccountNumber: "•••• 7890" }],
            assignments: [],
        });
        expect(JSON.stringify(profile)).not.toContain("1234567890");
        expect(JSON.stringify(profile)).not.toContain("accountNumberHash");

        const bankAudits = await db.select().from(auditLogs)
            .where(eq(auditLogs.entityType, "intermediary_bank_account"));
        expect(bankAudits).toHaveLength(2);
        expect(bankAudits.map((entry) => entry.action)).toEqual(["created", "saved"]);
        expect(bankAudits[0]).toMatchObject({
            actorUserId: actor.id,
            actorSource: "web",
            requestId: "req-bank-save-1",
            correlationId: "corr-bank-save-1",
        });
        expect(JSON.stringify(bankAudits)).not.toContain("1234567890");
    });

    // Break caught: different idempotency keys race the same reusable account hash into an unhandled unique violation.
    integrationTest("serializes concurrent reusable bank-account saves by account identity", async () => {
        const actor = await seedActor("tenant-account-race", "account-race-owner");
        const intermediary = await createIntermediary(context(actor), { name: "Account Race" });
        const input = {
            bankCode: "SCB",
            bankName: "Siam Commercial Bank",
            accountName: "Account Race",
            accountNumber: "111-1-22223-3",
        };

        const [first, second] = await Promise.all([
            saveIntermediaryBankAccount(context(actor, "account-race-a"), intermediary.publicId, input),
            saveIntermediaryBankAccount(context(actor, "account-race-b"), intermediary.publicId, input),
        ]);

        expect(first.publicId).toBe(second.publicId);
        expect(await db.select().from(intermediaryBankAccounts)).toHaveLength(1);
        const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityType, "intermediary_bank_account"));
        expect(audits.map((entry) => entry.action)).toEqual(["created", "saved"]);
    });

    // Break caught: current intermediary state prevents an exact retry from replaying its completed bank command.
    integrationTest("replays a completed bank save after the intermediary becomes inactive", async () => {
        const actor = await seedActor("tenant-account-replay", "account-replay-owner");
        const intermediary = await createIntermediary(context(actor), { name: "Replay Account" });
        const input = {
            bankName: "Krungthai Bank",
            accountName: "Replay Account",
            accountNumber: "999-9-00001-1",
        };
        const first = await saveIntermediaryBankAccount(
            context(actor, "account-replay-key"), intermediary.publicId, input,
        );
        await db.update(intermediaries).set({ status: "inactive" })
            .where(eq(intermediaries.publicId, intermediary.publicId));

        const replay = await saveIntermediaryBankAccount(
            context(actor, "account-replay-key"), intermediary.publicId, input,
        );
        expect(replay).toEqual(first);
        expect(await db.select().from(intermediaryBankAccounts)).toHaveLength(1);
        expect(await db.select().from(auditLogs).where(eq(auditLogs.entityType, "intermediary_bank_account"))).toHaveLength(1);
    });

    // Break caught: ending deletes history, active queries ignore effective dates/roles, or assignments lack audit/idempotency.
    integrationTest("retains multiple historical assignments and lists only active role-compatible managed loans", async () => {
        const actor = await seedActor("tenant-assignments", "assignment-owner");
        const intermediary = await createIntermediary(context(actor), { name: "Managed Collector" });
        const first = await seedLoan(actor, "first");
        const second = await seedLoan(actor, "second");
        const collectionOnly = await seedLoan(actor, "collection-only");
        const closed = await seedLoan(actor, "closed", "paid");

        const historical = await assignIntermediaryToLoan(
            context(actor, "assignment-history-1"),
            first.loan.publicId,
            { intermediaryPublicId: intermediary.publicId, role: "collection", effectiveFrom: "2026-01-01T00:00:00.000Z", note: "First period" },
        );
        const historicalReplay = await assignIntermediaryToLoan(
            context(actor, "assignment-history-1"),
            first.loan.publicId,
            { intermediaryPublicId: intermediary.publicId, role: "collection", effectiveFrom: "2026-01-01T00:00:00.000Z", note: "First period" },
        );
        expect(historicalReplay.publicId).toBe(historical.publicId);
        const ended = await endIntermediaryAssignment(
            context(actor, "assignment-end-1"),
            historical.publicId,
            { effectiveTo: "2026-02-01T00:00:00.000Z", reason: "Route changed" },
        );
        const endedReplay = await endIntermediaryAssignment(
            context(actor, "assignment-end-1"),
            historical.publicId,
            { effectiveTo: "2026-02-01T00:00:00.000Z", reason: "Route changed" },
        );
        expect(endedReplay).toEqual(ended);
        await assignIntermediaryToLoan(
            context(actor, "assignment-history-2"),
            first.loan.publicId,
            { intermediaryPublicId: intermediary.publicId, role: "collection", effectiveFrom: "2026-02-01T00:00:00.000Z", note: "Second period" },
        );
        const currentDisbursement = await assignIntermediaryToLoan(
            context(actor, "assignment-disbursement"),
            second.loan.publicId,
            { intermediaryPublicId: intermediary.publicId, role: "disbursement", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        );
        await assignIntermediaryToLoan(
            context(actor, "assignment-collection-only"),
            collectionOnly.loan.publicId,
            { intermediaryPublicId: intermediary.publicId, role: "collection", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        );
        await assignIntermediaryToLoan(
            context(actor, "assignment-closed"),
            closed.loan.publicId,
            { intermediaryPublicId: intermediary.publicId, role: "both", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        );

        const disbursementLoans = await listManagedLoans(context(actor), intermediary.publicId, { role: "disbursement" });
        expect(disbursementLoans).toEqual([expect.objectContaining({
            publicId: second.loan.publicId,
            borrowerPublicId: second.borrower.publicId,
            borrowerName: "Borrower second",
            principalAmount: "5000.00",
            outstandingPrincipal: "4321.00",
            assignment: expect.objectContaining({ publicId: currentDisbursement.publicId, role: "disbursement", status: "active" }),
        })]);
        expect(disbursementLoans[0]).not.toHaveProperty("borrowerId");
        expect(disbursementLoans[0].assignment).not.toHaveProperty("loanId");
        expect(disbursementLoans[0].assignment).not.toHaveProperty("intermediaryId");

        const profile = await getIntermediaryProfile(context(actor), intermediary.publicId);
        expect(profile.assignments).toHaveLength(5);
        expect(profile.assignments).toEqual(expect.arrayContaining([
            expect.objectContaining({ publicId: historical.publicId, status: "ended", effectiveTo: "2026-02-01T00:00:00.000Z" }),
            expect.objectContaining({ loanPublicId: first.loan.publicId, status: "active", effectiveFrom: "2026-02-01T00:00:00.000Z" }),
        ]));
        expect(await db.select().from(loanIntermediaryAssignments)).toHaveLength(5);

        const assignmentAudits = await db.select().from(auditLogs)
            .where(eq(auditLogs.entityType, "loan_intermediary_assignment"));
        expect(assignmentAudits).toHaveLength(6);
        expect(assignmentAudits.map((entry) => entry.action)).toEqual([
            "assigned", "ended", "assigned", "assigned", "assigned", "assigned",
        ]);
        expect(assignmentAudits[1]).toMatchObject({
            requestId: "req-assignment-end-1",
            correlationId: "corr-assignment-end-1",
        });
    });

    // Break caught: role ranges overlap silently, inactive/cross-tenant profiles can be assigned, or idempotency can be omitted/reused.
    integrationTest("rejects role overlaps, inactive profiles, missing keys, idempotency conflicts, and cross-tenant access", async () => {
        const actor = await seedActor("tenant-guards", "guard-owner");
        const otherActor = await seedActor("tenant-other", "other-owner");
        const loan = await seedLoan(actor, "guard");
        const otherLoan = await seedLoan(otherActor, "other");
        const collection = await createIntermediary(context(actor), { name: "Collection Agent" });
        const disbursement = await createIntermediary(context(actor), { name: "Disbursement Agent" });
        const inactive = await createIntermediary(context(actor), { name: "Inactive Agent" });
        await db.update(intermediaries).set({ status: "inactive" }).where(eq(intermediaries.publicId, inactive.publicId));

        await assignIntermediaryToLoan(
            context(actor, "guard-collection"),
            loan.loan.publicId,
            { intermediaryPublicId: collection.publicId, role: "collection", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        );
        const independentRole = await assignIntermediaryToLoan(
            context(actor, "guard-disbursement"),
            loan.loan.publicId,
            { intermediaryPublicId: disbursement.publicId, role: "disbursement", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        );
        expect(independentRole.role).toBe("disbursement");

        await expect(assignIntermediaryToLoan(
            context(actor, "guard-overlap"),
            loan.loan.publicId,
            { intermediaryPublicId: disbursement.publicId, role: "both", effectiveFrom: "2026-02-01T00:00:00.000Z" },
        )).rejects.toMatchObject({ code: "INTERMEDIARY_ASSIGNMENT_OVERLAP", status: 409 });
        await expect(assignIntermediaryToLoan(
            context(actor),
            loan.loan.publicId,
            { intermediaryPublicId: collection.publicId, role: "collection", effectiveFrom: "2027-01-01T00:00:00.000Z" },
        )).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED", status: 400 });
        await expect(assignIntermediaryToLoan(
            context(actor, "guard-inactive"),
            loan.loan.publicId,
            { intermediaryPublicId: inactive.publicId, role: "collection", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        )).rejects.toMatchObject({ code: "INTERMEDIARY_INACTIVE", status: 409 });
        await expect(assignIntermediaryToLoan(
            context(actor, "guard-cross-loan"),
            otherLoan.loan.publicId,
            { intermediaryPublicId: collection.publicId, role: "collection", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        )).rejects.toMatchObject({ code: "LOAN_NOT_FOUND", status: 404 });
        await expect(getIntermediaryProfile(context(otherActor), collection.publicId))
            .rejects.toMatchObject({ code: "INTERMEDIARY_NOT_FOUND", status: 404 });
        await expect(saveIntermediaryBankAccount(
            context(otherActor, "guard-cross-account"),
            collection.publicId,
            { bankName: "SCB", accountName: "Cross Tenant", accountNumber: "1111222233" },
        )).rejects.toMatchObject({ code: "INTERMEDIARY_NOT_FOUND", status: 404 });
        await expect(assignIntermediaryToLoan(
            context(actor, "guard-collection"),
            loan.loan.publicId,
            { intermediaryPublicId: disbursement.publicId, role: "disbursement", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        )).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", status: 409 });
        await expect(endIntermediaryAssignment(
            context(actor),
            independentRole.publicId,
            { effectiveTo: "2026-03-01T00:00:00.000Z", reason: "No key" },
        )).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED", status: 400 });
    });

    // Break caught: a profile owner can read another collector's borrower/loan through assignment history.
    integrationTest("keeps assignment history within the actor's existing owner scope", async () => {
        const first = await seedActor("tenant-owner-scope", "scope-first", "collector");
        const second = await seedActor("tenant-owner-scope", "scope-second", "collector");
        const intermediary = await createIntermediary(context(first), { name: "Private Route" });
        const privateLoan = await seedLoan(second, "private-second");
        const intermediaryRow = await db.query.intermediaries.findFirst({
            where: eq(intermediaries.publicId, intermediary.publicId),
        });
        await db.insert(loanIntermediaryAssignments).values({
            tenantId: first.tenantId,
            loanId: privateLoan.loan.id,
            intermediaryId: intermediaryRow!.id,
            role: "collection",
            effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
            idempotencyKey: "owner-scope-assignment",
            createdByUserId: first.id,
            updatedByUserId: first.id,
        });

        const profile = await getIntermediaryProfile(context(first), intermediary.publicId);
        expect(profile.assignments).toEqual([]);
        expect(await listManagedLoans(context(first), intermediary.publicId)).toEqual([]);
        expect(JSON.stringify(profile)).not.toContain(privateLoan.borrower.publicId);
        expect(JSON.stringify(profile)).not.toContain("Borrower private-second");
    });

    // Break caught: lifecycle status hides a responsibility whose effective end is still in the future.
    integrationTest("keeps a future-ended assignment in managed loans until its effective end", async () => {
        const actor = await seedActor("tenant-future-end", "future-end-owner");
        const intermediary = await createIntermediary(context(actor), { name: "Future End Route" });
        const managedLoan = await seedLoan(actor, "future-end");
        const assignment = await assignIntermediaryToLoan(
            context(actor, "future-end-assignment"),
            managedLoan.loan.publicId,
            { intermediaryPublicId: intermediary.publicId, role: "collection", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        );
        await endIntermediaryAssignment(
            context(actor, "future-end-command"),
            assignment.publicId,
            { effectiveTo: "2099-01-01T00:00:00.000Z", reason: "Scheduled handoff" },
        );

        const managed = await listManagedLoans(context(actor), intermediary.publicId, { role: "collection" });
        expect(managed).toEqual([expect.objectContaining({
            publicId: managedLoan.loan.publicId,
            assignment: expect.objectContaining({ status: "ended", effectiveTo: "2099-01-01T00:00:00.000Z" }),
        })]);
    });

    // Break caught: exact alias reuse discloses another collector's private profile UUID and notes.
    integrationTest("does not disclose an inaccessible profile through exact confirmed-alias reuse", async () => {
        const first = await seedActor("tenant-alias-scope", "alias-first", "collector");
        const second = await seedActor("tenant-alias-scope", "alias-second", "collector");
        const privateProfile = await createIntermediary(context(first), {
            name: "Private Collector",
            aliases: ["Confirmed Private Alias"],
            notes: "private route details",
        });

        await expect(createIntermediary(context(second), { name: "confirmed-private-alias" }))
            .rejects.toMatchObject({ code: "INTERMEDIARY_IDENTITY_CONFLICT", status: 409 });
        expect(await db.select().from(intermediaries)).toHaveLength(1);
        expect((await db.select().from(intermediaries))[0]?.publicId).toBe(privateProfile.publicId);
    });
});
