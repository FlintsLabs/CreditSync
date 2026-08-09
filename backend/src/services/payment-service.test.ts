import { beforeEach, describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs,
    bankProfiles,
    borrowers,
    files,
    fundLedgerEntries,
    loanFundingAllocations,
    loanSchedules,
    loans,
    paymentEvidence,
    paymentIntakes,
    paymentMatchAllocations,
    paymentMatchProposals,
    transactions,
    users,
} from "../db/schema";
import type { CommandContext } from "./command-context";
import type { SignedPutRequest } from "../lib/storage";
import {
    createPaymentIntake,
    finalizePaymentEvidence,
    getPaymentIntake,
    listPaymentIntakes,
    normalizeBankReference,
    postPayment,
    preparePaymentEvidence,
    previewPaymentMatch,
    reversePayment,
    reviewPaymentIntake,
    type EvidenceStorageGateway,
} from "./payment-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetApplicationTables() {
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, fund_ledger_entries, payment_match_allocations,
        payment_match_proposals, payment_evidence, transactions,
        payment_intakes, loan_funding_allocations, loan_schedules,
        loans, borrower_aliases, borrowers, bank_profiles, users
        RESTART IDENTITY CASCADE`);
}

async function seedUser(tenantId = "tenant-a", role: "owner" | "manager" | "collector" | "viewer" = "owner") {
    return db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role })
        .returning().then((rows) => rows[0]!);
}

function context(actor: { id: number; tenantId: string }, idempotencyKey: string = crypto.randomUUID()): CommandContext {
    return {
        tenantId: actor.tenantId,
        actorUserId: actor.id,
        actorSource: "web",
        requestId: `req-${crypto.randomUUID()}`,
        correlationId: `corr-${crypto.randomUUID()}`,
        idempotencyKey,
    };
}

async function seedLoan(input: {
    actor: { id: number; tenantId: string };
    borrowerName: string;
    alias?: string;
    schedules: Array<{ total: string; principal?: string; interest?: string; fee?: string; dueDate?: string }>;
    funded?: boolean;
}) {
    const borrower = await db.insert(borrowers).values({
        tenantId: input.actor.tenantId,
        ownerUserId: input.actor.id,
        name: input.borrowerName,
    }).returning().then((rows) => rows[0]!);
    if (input.alias) {
        await db.execute(sql`INSERT INTO borrower_aliases
            (tenant_id, borrower_id, alias, normalized_alias, status, confirmed_at, created_by_user_id, updated_by_user_id)
            VALUES (${input.actor.tenantId}, ${borrower.id}, ${input.alias}, ${input.alias.toLocaleLowerCase()}, 'confirmed', now(), ${input.actor.id}, ${input.actor.id})`);
    }
    const principal = input.schedules.reduce((sum, row) => sum + Number(row.principal ?? row.total), 0).toFixed(2);
    const loan = await db.insert(loans).values({
        tenantId: input.actor.tenantId,
        ownerUserId: input.actor.id,
        borrowerId: borrower.id,
        principalAmount: principal,
        interestRate: "0.00",
        repaymentType: "monthly",
        outstandingPrincipal: principal,
        outstandingInterest: "0.00",
        outstandingFees: "0.00",
        status: "active",
    }).returning().then((rows) => rows[0]!);
    const schedules = await db.insert(loanSchedules).values(input.schedules.map((row, index) => ({
        tenantId: input.actor.tenantId,
        loanId: loan.id,
        installmentNo: index + 1,
        dueDate: row.dueDate ?? `2026-${String(index + 8).padStart(2, "0")}-10`,
        scheduledPrincipal: row.principal ?? row.total,
        scheduledInterest: row.interest ?? "0.00",
        scheduledFee: row.fee ?? "0.00",
        scheduledTotal: row.total,
        paidTotal: "0.00",
        paidPenalty: "0.00",
        remainingDue: row.total,
        status: "pending",
    }))).returning();
    if (input.funded) {
        const profile = await db.insert(bankProfiles).values({
            tenantId: input.actor.tenantId,
            name: "Payment test fund",
            type: "personal_savings",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanFundingAllocations).values({
            tenantId: input.actor.tenantId,
            loanId: loan.id,
            bankProfileId: profile.id,
            allocatedAmount: principal,
            allocationDate: "2026-08-01",
            createdByUserId: input.actor.id,
        });
    }
    return { borrower, loan, schedules };
}

describe("payment application service", () => {
    // Break caught: visually equivalent references hash differently and bypass hard-duplicate detection.
    test("normalizes bank references deterministically without retaining punctuation differences", () => {
        expect(normalizeBankReference("  SCB—001 / 2569  ")).toBe("scb0012569");
    });

    if (integrationEnabled) beforeEach(resetApplicationTables);

    // Break caught: data-only intake is rejected, money is coerced through Number, or a retry creates a second row.
    integrationTest("creates a data-only intake and returns the existing UUID for every hard duplicate", async () => {
        const actor = await seedUser();
        const created = await createPaymentIntake(context(actor, "operation-1"), {
            amount: "9007199254740993.00",
            receivedAt: "2026-08-10T10:00:00.000Z",
            payerName: "Somchai",
            bankReference: "SCB-001",
            qrPayload: "raw-qr-is-hashed-only",
        });
        const byOperation = await createPaymentIntake(context(actor, "operation-1"), {
            amount: "1.00",
            receivedAt: "2026-08-10T11:00:00.000Z",
        });
        const byBank = await createPaymentIntake(context(actor, "operation-2"), {
            amount: "9007199254740993.00",
            receivedAt: "2026-08-10T10:00:00.000Z",
            bankReference: " SCB / 001 ",
        });
        const byQr = await createPaymentIntake(context(actor, "operation-3"), {
            amount: "9007199254740993.00",
            receivedAt: "2026-08-10T10:00:00.000Z",
            qrPayload: "raw-qr-is-hashed-only",
        });

        expect(created).toMatchObject({ id: created.publicId, amount: "9007199254740993.00", duplicate: false });
        expect(byOperation).toMatchObject({ publicId: created.publicId, duplicate: true, duplicateReason: "idempotency_key" });
        expect(byBank).toMatchObject({ publicId: created.publicId, duplicate: true, duplicateReason: "bank_reference" });
        expect(byQr).toMatchObject({ publicId: created.publicId, duplicate: true, duplicateReason: "qr_payload" });
        expect(await db.select().from(paymentIntakes)).toHaveLength(1);
        const stored = await db.query.paymentIntakes.findFirst();
        expect(stored?.amount).toBe("9007199254740993.00");
        expect(JSON.stringify(await db.select().from(auditLogs))).not.toContain("raw-qr-is-hashed-only");
    });

    // Break caught: amount/time/name similarity is promoted to a destructive duplicate decision.
    integrationTest("keeps semantic duplicates and reports a warning only", async () => {
        const actor = await seedUser();
        await createPaymentIntake(context(actor, "semantic-1"), {
            amount: "500.00", receivedAt: "2026-08-10T10:00:00.000Z", payerName: "Nok Dee",
        });
        const similar = await createPaymentIntake(context(actor, "semantic-2"), {
            amount: "500.00", receivedAt: "2026-08-10T10:03:00.000Z", payerName: " nok dee ",
        });
        expect(similar.duplicate).toBe(false);
        expect(similar.warnings).toEqual([expect.objectContaining({ code: "POSSIBLE_SEMANTIC_DUPLICATE" })]);
        expect(await db.select().from(paymentIntakes)).toHaveLength(2);
    });

    // Break caught: ambiguous confirmed nicknames or multiple exact obligations are auto-postable.
    integrationTest("auto-matches only one confirmed borrower and one exact obligation", async () => {
        const actor = await seedUser();
        const exact = await seedLoan({ actor, borrowerName: "Unique Customer", alias: "lek", schedules: [{ total: "100.00" }] });
        const intake = await createPaymentIntake(context(actor), {
            amount: "100.00", receivedAt: "2026-08-10T10:00:00.000Z", payerName: "LEK",
        });
        const preview = await previewPaymentMatch(context(actor), intake.publicId, {});
        expect(preview).toMatchObject({ version: 1, status: "ready", totalAllocated: "100.00" });
        expect(preview.allocations).toEqual([
            expect.objectContaining({ borrowerPublicId: exact.borrower.publicId, loanPublicId: exact.loan.publicId, amount: "100.00" }),
        ]);

        await seedLoan({ actor, borrowerName: "Other Customer", alias: "shared", schedules: [{ total: "100.00" }] });
        await seedLoan({ actor, borrowerName: "Third Customer", alias: "shared", schedules: [{ total: "100.00" }] });
        const ambiguous = await createPaymentIntake(context(actor), {
            amount: "100.00", receivedAt: "2026-08-10T12:00:00.000Z", payerName: "shared",
        });
        const ambiguousPreview = await previewPaymentMatch(context(actor), ambiguous.publicId, {});
        expect(ambiguousPreview.status).toBe("needs_review");
        expect(ambiguousPreview.warnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "AMBIGUOUS_BORROWER" }),
        ]));
    });

    // Break caught: split sums drift, UUID boundaries accept numeric IDs, or an advance cannot span schedules/borrowers.
    integrationTest("requires exact explicit sums and expands multi-borrower advance allocations by schedule", async () => {
        const actor = await seedUser();
        const first = await seedLoan({ actor, borrowerName: "First", schedules: [{ total: "40.00" }, { total: "60.00" }] });
        const second = await seedLoan({ actor, borrowerName: "Second", schedules: [{ total: "50.00" }] });
        const intake = await createPaymentIntake(context(actor), {
            amount: "120.00", receivedAt: "2026-08-10T10:00:00.000Z",
        });
        const mismatch = await previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [{ borrowerPublicId: first.borrower.publicId, loanPublicId: first.loan.publicId, amount: "119.99" }],
        });
        expect(mismatch).toMatchObject({ status: "needs_review", totalAllocated: "119.99" });
        expect(mismatch.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ALLOCATION_SUM_MISMATCH" })]));

        const repeated = await previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [
                { borrowerPublicId: first.borrower.publicId, loanPublicId: first.loan.publicId, amount: "70.00" },
                { borrowerPublicId: first.borrower.publicId, loanPublicId: first.loan.publicId, amount: "50.00" },
            ],
        });
        expect(repeated.status).toBe("needs_review");
        expect(repeated.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ALLOCATION_EXCEEDS_OBLIGATION" })]));

        const ready = await previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [
                { borrowerPublicId: first.borrower.publicId, loanPublicId: first.loan.publicId, amount: "70.00" },
                { borrowerPublicId: second.borrower.publicId, loanPublicId: second.loan.publicId, amount: "50.00" },
            ],
        });
        expect(ready).toMatchObject({ version: 3, status: "ready", totalAllocated: "120.00" });
        expect(ready.allocations.map((row) => row.amount)).toEqual(["40.00", "30.00", "50.00"]);
        expect(new Set(ready.allocations.map((row) => row.borrowerPublicId)).size).toBe(2);
        expect((await getPaymentIntake(context(actor), intake.publicId)).latestProposal).toMatchObject({
            publicId: ready.publicId,
            totalAllocated: "120.00",
            allocations: [
                expect.objectContaining({ schedulePublicId: first.schedules[0]!.publicId, amount: "40.00" }),
                expect.objectContaining({ schedulePublicId: first.schedules[1]!.publicId, amount: "30.00" }),
                expect.objectContaining({ schedulePublicId: second.schedules[0]!.publicId, amount: "50.00" }),
            ],
        });

        await expect(previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [{ borrowerPublicId: "1", loanPublicId: first.loan.publicId, amount: "120.00" }],
        })).rejects.toMatchObject({ code: "INVALID_PUBLIC_ID", status: 400 });
    });

    // Break caught: an owner-scoped collector allocates their intake to another collector's loan.
    integrationTest("enforces portfolio visibility on explicit payment targets", async () => {
        const collector = await seedUser("tenant-a", "collector");
        const otherCollector = await seedUser("tenant-a", "collector");
        const hidden = await seedLoan({ actor: otherCollector, borrowerName: "Hidden portfolio", schedules: [{ total: "25.00" }] });
        const intake = await createPaymentIntake(context(collector), {
            amount: "25.00", receivedAt: "2026-08-10T10:00:00.000Z",
        });

        await expect(previewPaymentMatch(context(collector), intake.publicId, {
            allocations: [{ borrowerPublicId: hidden.borrower.publicId, loanPublicId: hidden.loan.publicId, amount: "25.00" }],
        })).rejects.toMatchObject({ code: "INVALID_PAYMENT_TARGET", status: 400 });
    });

    // Break caught: preview/review reads draft before waiting on a lock, then overwrites a concurrently posted status.
    integrationTest("rechecks intake state after acquiring the mutation lock", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({ actor, borrowerName: "Lock target", schedules: [{ total: "20.00" }] });
        for (const operation of ["preview", "review"] as const) {
            const intake = await createPaymentIntake(context(actor), {
                amount: "20.00", receivedAt: `2026-08-10T1${operation === "preview" ? "0" : "1"}:00:00.000Z`,
            });
            const stored = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
            let locked!: () => void;
            let release!: () => void;
            const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
            const mayCommit = new Promise<void>((resolve) => { release = resolve; });
            const blocker = db.transaction(async (tx) => {
                await tx.execute(sql`SELECT id FROM payment_intakes WHERE id = ${stored!.id} FOR UPDATE`);
                locked();
                await mayCommit;
                await tx.update(paymentIntakes).set({ status: "posted", postedAt: new Date() }).where(eq(paymentIntakes.id, stored!.id));
            });
            await lockHeld;
            const mutation = operation === "preview"
                ? previewPaymentMatch(context(actor), intake.publicId, {
                    allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "20.00" }],
                })
                : reviewPaymentIntake(context(actor), intake.publicId, { status: "draft" });
            await Bun.sleep(20);
            release();
            await blocker;
            await expect(mutation).rejects.toMatchObject({ code: "PAYMENT_INTAKE_IMMUTABLE", status: 409 });
            expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, stored!.id) }))
                .toMatchObject({ status: "posted" });
        }
    });

    // Break caught: posting trusts an old preview or permits two callers to create duplicate transactions.
    integrationTest("rejects stale previews and serializes concurrent double post", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({ actor, borrowerName: "Poster", schedules: [{ total: "100.00" }] });
        const staleIntake = await createPaymentIntake(context(actor), {
            amount: "100.00", receivedAt: "2026-08-10T10:00:00.000Z",
        });
        const stalePreview = await previewPaymentMatch(context(actor), staleIntake.publicId, {
            allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "100.00" }],
        });
        await db.update(loanSchedules).set({ remainingDue: "90.00", updatedAt: new Date() })
            .where(eq(loanSchedules.id, seeded.schedules[0]!.id));
        await expect(postPayment(context(actor), staleIntake.publicId, { proposalPublicId: stalePreview.publicId }))
            .rejects.toMatchObject({ code: "STALE_PAYMENT_PROPOSAL", status: 409 });
        expect(await db.query.paymentMatchProposals.findFirst({ where: eq(paymentMatchProposals.publicId, stalePreview.publicId) }))
            .toMatchObject({ status: "stale" });

        const downgradedIntake = await createPaymentIntake(context(actor), {
            amount: "100.00", receivedAt: "2026-08-10T10:30:00.000Z",
        });
        const downgradedPreview = await previewPaymentMatch(context(actor), downgradedIntake.publicId, {
            allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "100.00" }],
        });
        await reviewPaymentIntake(context(actor), downgradedIntake.publicId, { status: "draft" });
        await expect(postPayment(context(actor), downgradedIntake.publicId, { proposalPublicId: downgradedPreview.publicId }))
            .rejects.toMatchObject({ code: "PAYMENT_NOT_READY", status: 409 });

        await db.update(loanSchedules).set({ remainingDue: "100.00", updatedAt: new Date() })
            .where(eq(loanSchedules.id, seeded.schedules[0]!.id));
        const liveIntake = await createPaymentIntake(context(actor), {
            amount: "100.00", receivedAt: "2026-08-10T11:00:00.000Z",
        });
        const livePreview = await previewPaymentMatch(context(actor), liveIntake.publicId, {
            allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "100.00" }],
        });
        const [first, second] = await Promise.all([
            postPayment(context(actor), liveIntake.publicId, { proposalPublicId: livePreview.publicId }),
            postPayment(context(actor), liveIntake.publicId, { proposalPublicId: livePreview.publicId }),
        ]);
        expect(first).toEqual(second);
        expect(first.status).toBe("posted");
        expect(await db.select().from(transactions).where(eq(transactions.paymentIntakeId, (await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, liveIntake.publicId) }))!.id))).toHaveLength(1);
    });

    // Break caught: posting fails to update schedules/loan/fund atomically or reversal mutates/deletes the original entries.
    integrationTest("posts partial payment effects and reverses them with compensating entries exactly once", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({ actor, borrowerName: "Funded", schedules: [{ total: "100.00" }], funded: true });
        const intake = await createPaymentIntake(context(actor), {
            amount: "40.00", receivedAt: "2026-08-10T10:00:00.000Z",
        });
        const preview = await previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "40.00" }],
        });
        const posted = await postPayment(context(actor), intake.publicId, { proposalPublicId: preview.publicId });
        expect(posted.transactions).toEqual([expect.objectContaining({ amount: "40.00", principalComponent: "40.00", entryType: "repayment" })]);
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedules[0]!.id) }))
            .toMatchObject({ paidTotal: "40.00", remainingDue: "60.00" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) }))
            .toMatchObject({ outstandingPrincipal: "60.00", status: "active" });
        expect(await db.select().from(fundLedgerEntries)).toEqual([
            expect.objectContaining({ entryType: "principal_return_in", amount: "40.00" }),
        ]);

        const reversed = await reversePayment(context(actor, "reverse-1"), intake.publicId);
        const retried = await reversePayment(context(actor, "reverse-2"), intake.publicId);
        expect(retried).toEqual(reversed);
        expect(reversed.status).toBe("reversed");
        expect(await db.select().from(transactions)).toEqual(expect.arrayContaining([
            expect.objectContaining({ amount: "40.00", entryType: "repayment", reversedTransactionId: null }),
            expect.objectContaining({ amount: "-40.00", entryType: "reversal" }),
        ]));
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedules[0]!.id) }))
            .toMatchObject({ paidTotal: "0.00", remainingDue: "100.00" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) }))
            .toMatchObject({ outstandingPrincipal: "100.00", status: "active" });
        expect(await db.select().from(fundLedgerEntries)).toEqual(expect.arrayContaining([
            expect.objectContaining({ entryType: "principal_return_in", amount: "40.00" }),
            expect.objectContaining({ entryType: "principal_return_reversal_out", amount: "40.00" }),
        ]));
        expect((await db.select().from(fundLedgerEntries)).reduce((balance, entry) =>
            entry.entryType.endsWith("_out") ? balance.minus(entry.amount) : balance.plus(entry.amount), new Decimal(0)).toFixed(2)).toBe("0.00");
    });

    // Break caught: reversing an older payment after a newer one rewrites component attribution for the wrong balance state.
    integrationTest("rejects out-of-order reversal when a later repayment remains posted", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({ actor, borrowerName: "Ordered payer", schedules: [{ total: "100.00" }] });
        const postAmount = async (amount: string, receivedAt: string) => {
            const intake = await createPaymentIntake(context(actor), { amount, receivedAt });
            const preview = await previewPaymentMatch(context(actor), intake.publicId, {
                allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount }],
            });
            await postPayment(context(actor), intake.publicId, { proposalPublicId: preview.publicId });
            return intake;
        };
        const first = await postAmount("40.00", "2026-08-10T10:00:00.000Z");
        await postAmount("10.00", "2026-08-10T10:10:00.000Z");

        await expect(reversePayment(context(actor), first.publicId))
            .rejects.toMatchObject({ code: "REVERSAL_NOT_LATEST", status: 409 });
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedules[0]!.id) }))
            .toMatchObject({ paidTotal: "50.00", remainingDue: "50.00" });
    });

    // Break caught: fixed late fees are omitted from preview/post or paid through floating point.
    integrationTest("allocates current penalty before mixed schedule components", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({
            actor,
            borrowerName: "Late payer",
            schedules: [{ total: "100.00", principal: "70.00", interest: "20.00", fee: "10.00", dueDate: "2026-08-01" }],
        });
        await db.update(loans).set({ lateFeeMode: "fixed", lateFeeAmount: "15.00" }).where(eq(loans.id, seeded.loan.id));
        const intake = await createPaymentIntake(context(actor), {
            amount: "45.00", receivedAt: "2026-08-10T10:00:00.000Z",
        });
        const preview = await previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "45.00" }],
        });
        expect(preview.status).toBe("ready");
        const posted = await postPayment(context(actor), intake.publicId, { proposalPublicId: preview.publicId });
        expect(posted.transactions).toEqual([
            expect.objectContaining({ penaltyComponent: "15.00", feeComponent: "10.00", interestComponent: "20.00", principalComponent: "0.00" }),
        ]);
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedules[0]!.id) }))
            .toMatchObject({ paidPenalty: "15.00", paidTotal: "30.00", remainingDue: "70.00" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) }))
            .toMatchObject({ outstandingFees: "0.00", outstandingInterest: "0.00", outstandingPrincipal: "70.00" });
    });

    // Break caught: finalize trusts client URLs/metadata or accepts another tenant's object/hash.
    integrationTest("prepares a tenant-owned signed PUT and finalizes only matching object metadata and checksum", async () => {
        const actor = await seedUser();
        const intake = await createPaymentIntake(context(actor), {
            amount: "50.00", receivedAt: "2026-08-10T10:00:00.000Z",
        });
        let captured: SignedPutRequest | undefined;
        const gateway: EvidenceStorageGateway = {
            preparePut: async (request) => {
                captured = request;
                return { uploadUrl: "https://storage.example.test/signed", expiresAt: new Date(Date.now() + 60_000) };
            },
            head: async () => ({
                exists: true,
                contentType: "image/png",
                contentLength: 12,
                checksumSha256: "a".repeat(64),
                metadata: {
                    tenant: "tenant-a",
                    intake: intake.publicId,
                },
            }),
        };
        const intent = await preparePaymentEvidence(context(actor), intake.publicId, {
            mimeType: "image/png", size: 12, sha256: "a".repeat(64),
        }, gateway);
        expect(intent.uploadUrl).toStartWith("https://storage.example.test/");
        expect(intent.objectKey).toStartWith(`payment-evidence/tenant-a/${intake.publicId}/`);
        expect(captured).toMatchObject({ contentType: "image/png", contentLength: 12, checksumSha256: "a".repeat(64) });
        const retriedIntent = await preparePaymentEvidence(context(actor), intake.publicId, {
            mimeType: "image/png", size: 12, sha256: "a".repeat(64),
        }, gateway);
        expect(retriedIntent).toMatchObject({ publicId: intent.publicId, objectKey: intent.objectKey });

        const finalized = await finalizePaymentEvidence(context(actor), intake.publicId, intent.publicId, gateway);
        expect(finalized).toMatchObject({ status: "ready", sha256: "a".repeat(64) });
        const file = await db.query.files.findFirst({ where: eq(files.publicId, finalized.filePublicId as string) });
        expect(file).toMatchObject({ tenantId: "tenant-a", mimeType: "image/png", size: 12 });

        const concurrentIntake = await createPaymentIntake(context(actor), {
            amount: "60.00", receivedAt: "2026-08-10T10:30:00.000Z",
        });
        let releaseHeads!: () => void;
        const bothHeadsReached = new Promise<void>((resolve) => { releaseHeads = resolve; });
        let headCalls = 0;
        const concurrentGateway: EvidenceStorageGateway = {
            preparePut: gateway.preparePut,
            head: async () => {
                headCalls += 1;
                if (headCalls === 2) releaseHeads();
                await bothHeadsReached;
                return {
                    exists: true, contentType: "image/png", contentLength: 12,
                    checksumSha256: "b".repeat(64),
                    metadata: { tenant: "tenant-a", intake: concurrentIntake.publicId },
                };
            },
        };
        const concurrentIntent = await preparePaymentEvidence(context(actor), concurrentIntake.publicId, {
            mimeType: "image/png", size: 12, sha256: "b".repeat(64),
        }, concurrentGateway);
        const concurrentFinalized = await Promise.all([
            finalizePaymentEvidence(context(actor), concurrentIntake.publicId, concurrentIntent.publicId, concurrentGateway),
            finalizePaymentEvidence(context(actor), concurrentIntake.publicId, concurrentIntent.publicId, concurrentGateway),
        ]);
        expect(concurrentFinalized[0]).toEqual(concurrentFinalized[1]);
        expect(concurrentFinalized[0]?.status).toBe("ready");

        const expiringIntake = await createPaymentIntake(context(actor), {
            amount: "61.00", receivedAt: "2026-08-10T10:40:00.000Z",
        });
        const expiringIntent = await preparePaymentEvidence(context(actor), expiringIntake.publicId, {
            mimeType: "image/png", size: 12, sha256: "f".repeat(64),
        }, gateway);
        await db.update(paymentEvidence).set({ updatedAt: new Date(Date.now() - 1_000_000) })
            .where(eq(paymentEvidence.publicId, expiringIntent.publicId));
        const replacementIntake = await createPaymentIntake(context(actor), {
            amount: "62.00", receivedAt: "2026-08-10T10:50:00.000Z",
        });
        const replacementIntent = await preparePaymentEvidence(context(actor), replacementIntake.publicId, {
            mimeType: "image/png", size: 12, sha256: "f".repeat(64),
        }, gateway);
        expect(replacementIntent.publicId).not.toBe(expiringIntent.publicId);
        expect(replacementIntent.objectKey).toContain(replacementIntake.publicId);
        expect(await db.select().from(paymentEvidence).where(eq(paymentEvidence.evidenceHash, "f".repeat(64)))).toHaveLength(1);

        await expect(preparePaymentEvidence(context(actor), intake.publicId, {
            mimeType: "text/html", size: 12, sha256: "c".repeat(64),
        }, gateway)).rejects.toMatchObject({ code: "INVALID_EVIDENCE", status: 400 });

        await expect(preparePaymentEvidence(context(actor), intake.publicId, {
            mimeType: "image/png", size: 12, sha256: "d".repeat(64),
        }, { ...gateway, preparePut: async () => { throw new Error("signing unavailable"); } })).rejects.toThrow("signing unavailable");
        expect(await db.query.paymentEvidence.findFirst({ where: eq(paymentEvidence.evidenceHash, "d".repeat(64)) })).toBeUndefined();

        const duplicateIntake = await createPaymentIntake(context(actor), {
            amount: "50.00", receivedAt: "2026-08-10T11:00:00.000Z",
        });
        const duplicateEvidence = await preparePaymentEvidence(context(actor), duplicateIntake.publicId, {
            mimeType: "image/png", size: 12, sha256: "a".repeat(64),
        }, gateway);
        expect(duplicateEvidence).toMatchObject({
            duplicate: true,
            duplicateReason: "evidence_sha256",
            intakePublicId: intake.publicId,
        });
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, duplicateIntake.publicId) }))
            .toMatchObject({ status: "duplicate", duplicateOfIntakeId: expect.any(Number) });
        expect(JSON.stringify(await db.select().from(auditLogs))).not.toContain("signed");
    });

    // Break caught: a duplicate-evidence prepare that races posting must never rewrite posted -> duplicate.
    integrationTest("rechecks evidence immutability under the intake row lock", async () => {
        const actor = await seedUser();
        const original = await createPaymentIntake(context(actor), { amount: "20.00", receivedAt: "2026-08-10T10:00:00.000Z" });
        const target = await createPaymentIntake(context(actor), { amount: "21.00", receivedAt: "2026-08-10T11:00:00.000Z" });
        const checksum = "e".repeat(64);
        const gateway: EvidenceStorageGateway = {
            preparePut: async () => ({ uploadUrl: "https://storage.example.test/signed", expiresAt: new Date(Date.now() + 60_000) }),
            head: async () => ({
                exists: true, contentType: "image/png", contentLength: 12, checksumSha256: checksum,
                metadata: { tenant: "tenant-a", intake: original.publicId },
            }),
        };
        const intent = await preparePaymentEvidence(context(actor), original.publicId, {
            mimeType: "image/png", size: 12, sha256: checksum,
        }, gateway);
        await finalizePaymentEvidence(context(actor), original.publicId, intent.publicId, gateway);

        let releaseLock!: () => void;
        let reportLocked!: () => void;
        const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
        const release = new Promise<void>((resolve) => { releaseLock = resolve; });
        const transition = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM payment_intakes WHERE public_id = ${target.publicId} FOR UPDATE`);
            reportLocked();
            await release;
            await tx.update(paymentIntakes).set({ status: "posted", postedAt: new Date() })
                .where(eq(paymentIntakes.publicId, target.publicId));
        });
        await locked;
        const attempt = preparePaymentEvidence(context(actor), target.publicId, {
            mimeType: "image/png", size: 12, sha256: checksum,
        }, gateway);
        const settled = attempt.then(() => null, (error) => error);
        await new Promise((resolve) => setTimeout(resolve, 20));
        releaseLock();
        await transition;
        expect(await settled).toMatchObject({ code: "PAYMENT_INTAKE_IMMUTABLE", status: 409 });
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, target.publicId) }))
            .toMatchObject({ status: "posted", duplicateOfIntakeId: null });
    });

    // Break caught: list/get leak numeric keys or records owned by another tenant.
    integrationTest("lists and gets intake DTOs with UUIDs and Decimal-safe strings", async () => {
        const actor = await seedUser();
        const other = await seedUser("tenant-b");
        const own = await createPaymentIntake(context(actor), { amount: "10.00", receivedAt: "2026-08-10T10:00:00.000Z" });
        await createPaymentIntake(context(other), { amount: "99.00", receivedAt: "2026-08-10T10:00:00.000Z" });
        expect(await getPaymentIntake(context(actor), own.publicId)).toMatchObject({ publicId: own.publicId, amount: "10.00" });
        expect(await listPaymentIntakes(context(actor), {})).toEqual([expect.objectContaining({ publicId: own.publicId, amount: "10.00" })]);
        expect(JSON.stringify(await listPaymentIntakes(context(actor), {}))).not.toContain('"id":1');
    });
});
