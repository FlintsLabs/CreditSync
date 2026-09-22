import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { files, paymentEvidence, paymentIntakes, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createPaymentIntake } from "./payment-service";
import { cancelPaymentIntake, getPaymentCancellationCapability } from "./payment-cancellation-service";
import { executePaymentDuplicateReview, previewPaymentDuplicateReview } from "./payment-duplicate-review-service";
import { createPaymentReplacement, inspectPaymentReplacement } from "./payment-replacement-service";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
const tenantId = "duplicate-review-regression";
type Actor = { id: number };
function ctx(actor: Actor): CommandContext { return { tenantId, actorUserId: actor.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() }; }
async function reset() { await db.execute(sql`TRUNCATE users CASCADE`); }
async function actor(role: "owner" | "collector" | "viewer" = "owner") { return (await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@test.invalid`, role }).returning())[0]!; }
async function evidence(owner: Actor, intakeId: number, hash: string) {
    const file = (await db.insert(files).values({ tenantId, ownerUserId: owner.id, bucket: "synthetic", key: crypto.randomUUID(), originalName: "synthetic.png", mimeType: "image/png", size: 20, url: "storage:synthetic" }).returning())[0]!;
    await db.insert(paymentEvidence).values({ tenantId, paymentIntakeId: intakeId, fileId: file.id, status: "ready", evidenceType: "slip", evidenceHash: hash.repeat(64), mimeType: "image/png", declaredSize: 20, finalizedAt: new Date(), createdByUserId: owner.id, updatedByUserId: owner.id });
}
async function cancelled(owner: Actor, hash?: string) {
    const receipt = await createPaymentIntake(ctx(owner), { amount: "200.00", receivedAt: "2026-09-21T12:05:00.000Z", payerName: "Synthetic Exact Payer" });
    const row = (await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, receipt.publicId) }))!;
    if (hash) await evidence(owner, row.id, hash);
    const capability = await getPaymentCancellationCapability(ctx(owner), receipt.publicId);
    await cancelPaymentIntake(ctx(owner), receipt.publicId, { reason: "synthetic duplicate correction", idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash });
    return row;
}
async function preview(owner: Actor, source: { publicId: string }, candidates: Array<{ publicId: string }>) {
    return previewPaymentDuplicateReview(ctx(owner), { canonicalPaymentIntakePublicId: source.publicId, candidatePaymentIntakePublicIds: candidates.map(x => x.publicId), reason: "synthetic reviewed same receipt", idempotencyKey: crypto.randomUUID() });
}
function execution(p: Awaited<ReturnType<typeof preview>>, key = crypto.randomUUID()) { return { duplicateReviewPublicId: p.duplicateReviewPublicId, previewHash: p.previewHash, confirmed: true as const, reason: "synthetic explicit confirmation", idempotencyKey: key }; }

describe("reviewed cancelled duplicate safety regressions", () => {
    integration("rejects a candidate with conflicting finalized evidence", async () => {
        await reset(); const owner = await actor(); const source = await cancelled(owner, "a"); const candidate = await cancelled(owner, "b");
        await expect(preview(owner, source, [candidate])).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REVIEW_HARD_IDENTITY_CONFLICT" });
    });
    integration("supports multiple exact candidates in one confirmed group", async () => {
        await reset(); const owner = await actor(); const source = await cancelled(owner, "a"); const a = await cancelled(owner); const b = await cancelled(owner);
        const p = await preview(owner, source, [a, b]);
        expect((await executePaymentDuplicateReview(ctx(owner), execution(p))).status).toBe("executed");
        expect((await inspectPaymentReplacement(ctx(owner), source.publicId)).allowed).toBe(true);
    });
    integration("rejects a pre-previewed candidate claimed by another canonical", async () => {
        await reset(); const owner = await actor(); const a = await cancelled(owner, "a"); const b = await cancelled(owner); const c = await cancelled(owner, "c");
        const ab = await preview(owner, a, [b]); const ba = await preview(owner, c, [b]);
        await executePaymentDuplicateReview(ctx(owner), execution(ab));
        await expect(executePaymentDuplicateReview(ctx(owner), execution(ba))).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REVIEW_MEMBERSHIP_CONFLICT" });
    });
    integration("reauthorizes collector ownership before execution and retry", async () => {
        await reset(); const owner = await actor(); const other = await actor("collector"); const source = await cancelled(owner, "a"); const candidate = await cancelled(owner);
        const p = await preview(owner, source, [candidate]); const command = execution(p);
        await expect(executePaymentDuplicateReview(ctx(other), command)).rejects.toMatchObject({ code: "PAYMENT_INTAKE_NOT_FOUND" });
        await executePaymentDuplicateReview(ctx(owner), command);
        await expect(executePaymentDuplicateReview(ctx(other), command)).rejects.toMatchObject({ code: "PAYMENT_INTAKE_NOT_FOUND" });
    });
    integration("returns one receipt for concurrent identical preview and execution", async () => {
        await reset(); const owner = await actor(); const source = await cancelled(owner, "a"); const candidate = await cancelled(owner);
        const input = { canonicalPaymentIntakePublicId: source.publicId, candidatePaymentIntakePublicIds: [candidate.publicId], reason: "same receipt", idempotencyKey: crypto.randomUUID() };
        const [p, q] = await Promise.all([previewPaymentDuplicateReview(ctx(owner), input), previewPaymentDuplicateReview(ctx(owner), input)]);
        expect(p).toEqual(q); const command = execution(p);
        const [a, b] = await Promise.all([executePaymentDuplicateReview(ctx(owner), command), executePaymentDuplicateReview(ctx(owner), command)]);
        expect(a).toEqual(b);
        await expect(executePaymentDuplicateReview(ctx(owner), { ...command, reason: "changed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });
    integration("expires unexecuted preview but retains executed review after fifteen minutes", async () => {
        await reset(); const owner = await actor(); const source = await cancelled(owner, "a"); const candidate = await cancelled(owner);
        const p = await preview(owner, source, [candidate]); const originalNow = Date.now;
        try {
            Date.now = () => new Date(p.expiresAt).getTime() + 1;
            await expect(executePaymentDuplicateReview(ctx(owner), execution(p))).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REVIEW_EXPIRED" });
        } finally { Date.now = originalNow; }
        await executePaymentDuplicateReview(ctx(owner), execution(p));
        try {
            Date.now = () => new Date(p.expiresAt).getTime() + 60_000;
            const inspection = await inspectPaymentReplacement(ctx(owner), source.publicId);
            expect(inspection.allowed).toBe(true);
            const r = await createPaymentReplacement(ctx(owner), { paymentIntakePublicId: source.publicId, expectedStateHash: inspection.stateHash, reason: "synthetic replacement", idempotencyKey: crypto.randomUUID() });
            expect(r.status).toBe("draft");
        } finally { Date.now = originalNow; }
    });
    integration("permits a later canonical's exact reviewed warning while preserving stored warnings", async () => {
        await reset(); const owner = await actor(); const candidate = await cancelled(owner); const source = await cancelled(owner, "a");
        const before = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, source.id) });
        const p = await preview(owner, source, [candidate]); await executePaymentDuplicateReview(ctx(owner), execution(p));
        expect((await inspectPaymentReplacement(ctx(owner), source.publicId)).allowed).toBe(true);
        expect((await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, source.id) }))?.warnings).toEqual(before?.warnings);
    });
});
