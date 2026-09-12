import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, files, loans, paymentBatchItems, paymentBatches, paymentBatchStagingItems, paymentEvidence, paymentIntakeCancellations, paymentIntakes, users } from "../db/schema";
import { assertNoOlderPendingPayment } from "./payment-chronology-service";
import { Elysia } from "elysia";
import { paymentIntakesRoute } from "../modules/payment-intakes";
import { createDefaultMcpToolHandlers } from "../mcp/default";
import type { CommandContext } from "./command-context";
import { cancelPaymentIntake, getPaymentCancellationCapability } from "./payment-cancellation-service";
import { createPaymentIntake, previewPaymentMatch, reviewPaymentIntake, preparePaymentEvidence, type EvidenceStorageGateway } from "./payment-service";
import { addPaymentBatchItem, cancelPaymentBatch, createPaymentBatch, getPaymentBatch } from "./payment-batch-service";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("independent payment cancellation acceptance", () => {
    let ctx: CommandContext;
    beforeEach(async () => {
        await db.execute(sql`TRUNCATE TABLE audit_logs, payment_intake_cancellations, payment_intakes, users CASCADE`);
        const [user] = await db.insert(users).values({ tenantId: "cancellation-review", email: "synthetic-cancel@example.invalid", role: "owner" }).returning();
        ctx = { tenantId: user!.tenantId, actorUserId: user!.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
    });
    const create = () => createPaymentIntake(ctx, { amount: "12.34", receivedAt: "2026-09-11T08:00:00.000Z", payerName: "Synthetic acceptance" });
    async function request(id: string) {
        return { reason: "Entered in error", idempotencyKey: crypto.randomUUID(), expectedStateHash: (await getPaymentCancellationCapability(ctx, id)).stateHash };
    }
    async function restCancel(id: string, body: object, extraHeaders: Record<string, string> = {}) {
        const actor = await db.query.users.findFirst({ where: eq(users.id, ctx.actorUserId!) });
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ id: actor!.id, email: actor!.email, role: actor!.role, tenantId: actor!.tenantId })}`;
        const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url");
        return new Elysia().use(paymentIntakesRoute).handle(new Request(`http://localhost/payment-intakes/${id}/cancel`, { method: "POST", headers: { authorization: `Bearer ${unsigned}.${signature}`, "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body) }));
    }

    test("REST cancellation and MCP retry return the same durable receipt", async () => {
        const intake = await create();
        const input = { ...await request(intake.publicId), reason: "x".repeat(1200) };
        const response = await restCancel(intake.publicId, input);
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result).toMatchObject({ paymentIntakePublicId: intake.publicId, status: "cancelled", reason: input.reason });
        const replay = await createDefaultMcpToolHandlers()["payment.cancel"]({ ...ctx, actorSource: "mcp" }, { paymentIntakePublicId: intake.publicId, ...input });
        expect(replay).toEqual(result);
        expect(await db.select().from(paymentIntakeCancellations)).toHaveLength(1);
    });

    test("REST rejects conflicting header keys and unexpected fields before mutation", async () => {
        const intake = await create();
        const input = await request(intake.publicId);
        expect((await restCancel(intake.publicId, input, { "idempotency-key": "different-intent" })).status).toBe(409);
        const extra = await restCancel(intake.publicId, { ...input, force: true });
        expect(extra.status).toBeGreaterThanOrEqual(400);
        expect(await db.select().from(paymentIntakeCancellations)).toHaveLength(0);
    });

    test("REST rejects malformed public UUIDs as client errors", async () => {
        const intake = await create();
        const response = await restCancel("not-a-public-uuid", await request(intake.publicId));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        expect(await db.select().from(paymentIntakeCancellations)).toHaveLength(0);
    });

    test("rejects an outdated fingerprint without creating a cancellation receipt", async () => {
        const intake = await create();
        const input = await request(intake.publicId);
        await reviewPaymentIntake(ctx, intake.publicId, { status: "needs_review", notes: "Reviewed after inspection" });
        await expect(cancelPaymentIntake(ctx, intake.publicId, input)).rejects.toMatchObject({ code: "PAYMENT_CANCEL_STALE" });
        expect(await db.select().from(paymentIntakeCancellations)).toHaveLength(0);
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) })).toMatchObject({ status: "needs_review" });
    });

    test("denies a null-role owner and reauthorizes an already completed command", async () => {
        const intake = await create();
        const input = await request(intake.publicId);
        await cancelPaymentIntake(ctx, intake.publicId, input);
        await db.update(users).set({ role: null }).where(eq(users.id, ctx.actorUserId!));
        expect(await getPaymentCancellationCapability(ctx, intake.publicId)).toMatchObject({ allowed: false, blockedReason: "PAYMENT_CANCEL_FORBIDDEN" });
        await expect(cancelPaymentIntake(ctx, intake.publicId, input)).rejects.toMatchObject({ code: "PAYMENT_CANCEL_FORBIDDEN" });
        expect(await db.select().from(paymentIntakeCancellations)).toHaveLength(1);
    });

    test("does not expose or cancel an intake to another tenant", async () => {
        const intake = await create();
        const input = await request(intake.publicId);
        const [otherActor] = await db.insert(users).values({ tenantId: "other-review-tenant", email: "other@example.invalid", role: "owner" }).returning();
        const other = { ...ctx, tenantId: otherActor!.tenantId, actorUserId: otherActor!.id };
        await expect(getPaymentCancellationCapability(other, intake.publicId)).rejects.toMatchObject({ code: "PAYMENT_INTAKE_NOT_FOUND" });
        await expect(cancelPaymentIntake(other, intake.publicId, input)).rejects.toMatchObject({ code: "PAYMENT_INTAKE_NOT_FOUND" });
        expect(await db.select().from(paymentIntakeCancellations)).toHaveLength(0);
    });

    test("refuses terminal statuses without executing a reversal or creating a receipt", async () => {
        for (const status of ["posted", "reversed", "duplicate"] as const) {
            const [row] = await db.insert(paymentIntakes).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, amount: "12.34", receivedAt: new Date("2026-09-11T08:00:00.000Z"), status, createdByUserId: ctx.actorUserId }).returning();
            const capability = await getPaymentCancellationCapability(ctx, row!.publicId);
            expect(capability.allowed).toBe(false);
            if (status === "posted") expect(capability.blockedReason).toBe("PAYMENT_REVERSE_REQUIRED");
            await expect(cancelPaymentIntake(ctx, row!.publicId, { reason: "Must not mutate", idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash })).rejects.toMatchObject({ code: "PAYMENT_CANCEL_NOT_ALLOWED" });
            expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, row!.id) })).toMatchObject({ status });
        }
        expect(await db.select().from(paymentIntakeCancellations)).toHaveLength(0);
    });

    test("cancelled intake cannot be reviewed, previewed, evidenced, or attached to a batch", async () => {
        const intake = await create();
        await cancelPaymentIntake(ctx, intake.publicId, await request(intake.publicId));
        await expect(reviewPaymentIntake(ctx, intake.publicId, { status: "draft" })).rejects.toMatchObject({ status: 409 });
        await expect(previewPaymentMatch(ctx, intake.publicId, {})).rejects.toMatchObject({ status: 409 });
        await expect(preparePaymentEvidence(ctx, intake.publicId, { mimeType: "image/png", size: 8, sha256: "a".repeat(64) })).rejects.toMatchObject({ status: 409 });
        const batch = await createPaymentBatch(ctx, { idempotencyKey: crypto.randomUUID() });
        await expect(addPaymentBatchItem(ctx, batch.publicId, { paymentIntakePublicId: intake.publicId, itemOrder: 1 })).rejects.toMatchObject({ code: "PAYMENT_BATCH_ITEM_NOT_ELIGIBLE" });
    });

    test("storage failure after cancellation retains the pending evidence and file", async () => {
        const intake = await create();
        const started = Promise.withResolvers<void>();
        const storage = Promise.withResolvers<Awaited<ReturnType<EvidenceStorageGateway["preparePut"]>>>();
        const gateway: EvidenceStorageGateway = { preparePut: async () => { started.resolve(); return storage.promise; }, head: async () => { throw new Error("Unexpected storage inspection"); } };
        const preparation = preparePaymentEvidence(ctx, intake.publicId, { mimeType: "image/png", size: 8, sha256: "b".repeat(64) }, gateway);
        const outcome = preparation.then(() => null, (error: unknown) => error);
        await started.promise;
        const before = await db.select().from(paymentEvidence);
        expect(before).toHaveLength(1);
        await cancelPaymentIntake(ctx, intake.publicId, await request(intake.publicId));
        storage.reject(new Error("Synthetic storage failure"));
        expect(await outcome).toBeInstanceOf(Error);
        expect(await db.select().from(paymentEvidence)).toEqual(before);
        expect(await db.select().from(files).where(eq(files.id, before[0]!.fileId!))).toHaveLength(1);
    });

    test("expired evidence on a cancelled intake remains reserved against reuse", async () => {
        const intake = await create();
        const gateway: EvidenceStorageGateway = { preparePut: async () => ({ uploadUrl: "https://storage.example.invalid/synthetic", expiresAt: new Date(Date.now() + 60_000) }), head: async () => { throw new Error("Unexpected storage inspection"); } };
        const evidenceInput = { mimeType: "image/png", size: 8, sha256: "c".repeat(64) };
        await preparePaymentEvidence(ctx, intake.publicId, evidenceInput, gateway);
        await db.update(paymentEvidence).set({ uploadExpiresAt: new Date("2026-01-01T00:00:00.000Z") });
        const before = await db.select().from(paymentEvidence);
        await cancelPaymentIntake(ctx, intake.publicId, await request(intake.publicId));
        const other = await create();
        await expect(preparePaymentEvidence(ctx, other.publicId, evidenceInput, gateway)).rejects.toMatchObject({ status: 409 });
        expect(await db.select().from(paymentEvidence)).toEqual(before);
        expect(await db.select().from(files).where(eq(files.id, before[0]!.fileId!))).toHaveLength(1);
    });

    test("direct member cancellation is rejected and child dependency rolls back the whole batch", async () => {
        const first = await create();
        const second = await create();
        const batch = await createPaymentBatch(ctx, { idempotencyKey: crypto.randomUUID() });
        await addPaymentBatchItem(ctx, batch.publicId, { paymentIntakePublicId: first.publicId, itemOrder: 1 });
        const current = await addPaymentBatchItem(ctx, batch.publicId, { paymentIntakePublicId: second.publicId, itemOrder: 2 });
        await expect(cancelPaymentIntake(ctx, first.publicId, await request(first.publicId))).rejects.toMatchObject({ code: "PAYMENT_CANCEL_BATCH_REQUIRED" });
        const original = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, first.publicId) });
        await db.update(paymentIntakes).set({ repostOfIntakeId: original!.id }).where(eq(paymentIntakes.publicId, second.publicId));
        await expect(cancelPaymentBatch(ctx, batch.publicId, { reason: "Wrong group", revision: current.version, idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "PAYMENT_CANCEL_DEPENDENCY_REQUIRED" });
        expect((await getPaymentBatch(ctx, batch.publicId)).status).not.toBe("cancelled");
        expect(await db.select().from(paymentIntakeCancellations)).toHaveLength(0);
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, first.publicId) })).toMatchObject({ status: "draft" });
    });

    test("batch cancellation retries return the entire original receipt without new child receipts", async () => {
        const intake = await create();
        const batch = await createPaymentBatch(ctx, { idempotencyKey: crypto.randomUUID() });
        const attached = await addPaymentBatchItem(ctx, batch.publicId, { paymentIntakePublicId: intake.publicId, itemOrder: 1 });
        const input = { reason: "Synthetic batch cancellation", revision: attached.version, idempotencyKey: crypto.randomUUID() };
        const first = await cancelPaymentBatch(ctx, batch.publicId, input);
        const retry = await cancelPaymentBatch({ ...ctx, correlationId: crypto.randomUUID() }, batch.publicId, input);
        expect(retry).toEqual(first);
        expect(await db.select().from(paymentIntakeCancellations)).toHaveLength(1);
    });

    test("cancellation clears only the exact mapped chronology blocker", async () => {
        const [borrower] = await db.insert(borrowers).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, name: "Synthetic chronology" }).returning();
        const [loan] = await db.insert(loans).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, borrowerId: borrower!.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "100.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning();
        const mapped = () => createPaymentIntake(ctx, { amount: "12.34", receivedAt: "2026-09-10T08:00:00.000Z", originLoanPublicId: loan!.publicId });
        const first = await mapped();
        const second = await mapped();
        const check = () => assertNoOlderPendingPayment(db, ctx.tenantId, borrower!.id, new Date("2026-09-11T08:00:00.000Z"), []);
        await expect(check()).rejects.toMatchObject({ status: 409 });
        await cancelPaymentIntake(ctx, first.publicId, await request(first.publicId));
        await expect(check()).rejects.toMatchObject({ status: 409 });
        await cancelPaymentIntake(ctx, second.publicId, await request(second.publicId));
        await check();
        expect(await db.select().from(paymentIntakeCancellations)).toHaveLength(2);
    });

    test("legacy duplicate intake does not block later chronology, but an older draft still does", async () => {
        const [borrower] = await db.insert(borrowers).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, name: "Synthetic duplicate chronology" }).returning();
        const duplicate = await createPaymentIntake(ctx, { amount: "1.00", receivedAt: "2026-09-04T17:00:00.000Z", payerName: "Legacy duplicate" });
        const duplicateBatch = await createPaymentBatch(ctx, { idempotencyKey: crypto.randomUUID(), borrowerPublicId: borrower!.publicId });
        await addPaymentBatchItem(ctx, duplicateBatch.publicId, { paymentIntakePublicId: duplicate.publicId, itemOrder: 1 });
        await db.update(paymentIntakes).set({ status: "duplicate", updatedAt: new Date() }).where(eq(paymentIntakes.publicId, duplicate.publicId));

        const laterReceivedAt = new Date("2026-09-10T04:15:00.000Z");
        await assertNoOlderPendingPayment(db, ctx.tenantId, borrower!.id, laterReceivedAt, []);

        const draft = await createPaymentIntake(ctx, { amount: "2.00", receivedAt: "2026-09-05T17:00:00.000Z", payerName: "Older draft" });
        const draftBatch = await createPaymentBatch(ctx, { idempotencyKey: crypto.randomUUID(), borrowerPublicId: borrower!.publicId });
        await addPaymentBatchItem(ctx, draftBatch.publicId, { paymentIntakePublicId: draft.publicId, itemOrder: 1 });
        await expect(assertNoOlderPendingPayment(db, ctx.tenantId, borrower!.id, laterReceivedAt, [])).rejects.toMatchObject({ code: "PAYMENT_CHRONOLOGY_CONFLICT" });
    });

    test("a validated staging row for a posted intake does not block later chronology", async () => {
        const [borrower] = await db.insert(borrowers).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, name: "Synthetic posted batch borrower" }).returning();
        const [batch] = await db.insert(paymentBatches).values({ tenantId: ctx.tenantId, borrowerId: borrower!.id, status: "draft", version: 1, stateHash: "v1:posted-member", createIdempotencyKey: crypto.randomUUID(), createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning();
        const [intake] = await db.insert(paymentIntakes).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, amount: "10.00", receivedAt: new Date("2026-09-05T08:00:00.000Z"), status: "posted", postedAt: new Date("2026-09-05T08:01:00.000Z"), postedByUserId: ctx.actorUserId, createdByUserId: ctx.actorUserId }).returning();
        const [staging] = await db.insert(paymentBatchStagingItems).values({ tenantId: ctx.tenantId, batchId: batch!.id, clientItemKey: "posted-member", payloadFingerprint: "posted-member-fingerprint", amount: "10.00", receivedAt: intake!.receivedAt, status: "validated", paymentIntakeId: intake!.id, reviewedMapping: { borrowerPublicId: borrower!.publicId }, resolutionState: "mapped", createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning();
        const [item] = await db.insert(paymentBatchItems).values({ tenantId: ctx.tenantId, batchId: batch!.id, paymentIntakeId: intake!.id, stagingItemId: staging!.id, itemOrder: 1 }).returning();
        await db.update(paymentBatchStagingItems).set({ batchItemId: item!.id }).where(eq(paymentBatchStagingItems.id, staging!.id));

        await assertNoOlderPendingPayment(db, ctx.tenantId, borrower!.id, new Date("2026-09-06T08:00:00.000Z"), []);
        // Reversal is the valid terminal transition for an already posted intake.
        for (const status of ["reversed"] as const) {
            await db.update(paymentIntakes).set({ status, updatedAt: new Date() }).where(eq(paymentIntakes.id, intake!.id));
            await assertNoOlderPendingPayment(db, ctx.tenantId, borrower!.id, new Date("2026-09-06T08:00:00.000Z"), []);
        }
    });

    test("a pending member still blocks when its batch also contains a posted member", async () => {
        const [borrower] = await db.insert(borrowers).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, name: "Synthetic mixed batch borrower" }).returning();
        const [batch] = await db.insert(paymentBatches).values({ tenantId: ctx.tenantId, borrowerId: borrower!.id, status: "draft", version: 1, stateHash: "v1:mixed-members", createIdempotencyKey: crypto.randomUUID(), createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning();
        for (const [index, status] of (["posted", "draft"] as const).entries()) {
            const receivedAt = new Date(`2026-09-05T0${8 + index}:00:00.000Z`);
            const [intake] = await db.insert(paymentIntakes).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, amount: "10.00", receivedAt, status, ...(status === "posted" ? { postedAt: new Date(receivedAt.getTime() + 60_000), postedByUserId: ctx.actorUserId } : {}), createdByUserId: ctx.actorUserId }).returning();
            const [staging] = await db.insert(paymentBatchStagingItems).values({ tenantId: ctx.tenantId, batchId: batch!.id, clientItemKey: `mixed-member-${index}`, payloadFingerprint: `mixed-member-fingerprint-${index}`, amount: "10.00", receivedAt, status: "validated", paymentIntakeId: intake!.id, reviewedMapping: { borrowerPublicId: borrower!.publicId }, resolutionState: "mapped", createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning();
            const [item] = await db.insert(paymentBatchItems).values({ tenantId: ctx.tenantId, batchId: batch!.id, paymentIntakeId: intake!.id, stagingItemId: staging!.id, itemOrder: index + 1 }).returning();
            await db.update(paymentBatchStagingItems).set({ batchItemId: item!.id }).where(eq(paymentBatchStagingItems.id, staging!.id));
        }

        await expect(assertNoOlderPendingPayment(db, ctx.tenantId, borrower!.id, new Date("2026-09-06T08:00:00.000Z"), [])).rejects.toMatchObject({ code: "PAYMENT_CHRONOLOGY_CONFLICT" });
    });

    test("racing review cannot revive a cancelled intake", async () => {
        const intake = await create();
        const input = await request(intake.publicId);
        const outcomes = await Promise.allSettled([
            cancelPaymentIntake(ctx, intake.publicId, input),
            reviewPaymentIntake(ctx, intake.publicId, { status: "needs_review", notes: "Concurrent review" }),
        ]);
        const row = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
        const receipts = await db.select().from(paymentIntakeCancellations);
        if (outcomes[0]!.status === "fulfilled") {
            expect(row!.status).toBe("cancelled");
            expect(outcomes[1]!.status).toBe("rejected");
            expect(receipts).toHaveLength(1);
        } else {
            expect(outcomes[1]!.status).toBe("fulfilled");
            expect(row!.status).toBe("needs_review");
            expect(receipts).toHaveLength(0);
        }
    });

    test("racing batch attachment cannot attach a cancelled intake", async () => {
        const intake = await create();
        const input = await request(intake.publicId);
        const batch = await createPaymentBatch(ctx, { idempotencyKey: crypto.randomUUID() });
        const outcomes = await Promise.allSettled([
            cancelPaymentIntake(ctx, intake.publicId, input),
            addPaymentBatchItem(ctx, batch.publicId, { paymentIntakePublicId: intake.publicId, itemOrder: 1 }),
        ]);
        const row = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
        const memberships = await db.select().from(paymentBatchItems).where(eq(paymentBatchItems.paymentIntakeId, row!.id));
        if (outcomes[0]!.status === "fulfilled") {
            expect(row!.status).toBe("cancelled");
            expect(memberships).toHaveLength(0);
            expect(outcomes[1]!.status).toBe("rejected");
        } else {
            expect(outcomes[1]!.status).toBe("fulfilled");
            expect(row!.status).not.toBe("cancelled");
            expect(memberships).toHaveLength(1);
        }
    });
});
