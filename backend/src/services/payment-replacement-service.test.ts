import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, files, financialEvidenceRequirements, loanSchedules, loans, paymentEvidence, paymentIntakes, paymentReplacementEvidenceReferences, paymentReplacementLineages, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createPaymentIntake, getPaymentIntake, postPayment, previewPaymentMatch } from "./payment-service";
import { preparePaymentEvidence } from "./payment-service";
import { cancelPaymentIntake, getPaymentCancellationCapability } from "./payment-cancellation-service";
import { createPaymentReplacement, inspectPaymentReplacement } from "./payment-replacement-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
const tenantId = "replacement-test";
function ctx(user: { id: number }): CommandContext { return { tenantId, actorUserId: user.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() }; }

async function reset() { await db.execute(sql`TRUNCATE TABLE payment_replacement_evidence_references, payment_replacement_lineages, payment_evidence, payment_intakes, audit_logs, files, users CASCADE`); }
async function user(role: "owner" | "viewer" = "owner") { return db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@test.invalid`, role }).returning().then((rows) => rows[0]!); }

describe("cancelled payment replacement", () => {
    integrationTest("blocks replacement when the authoritative evidence requirement is incomplete", async () => {
        await reset();
        const owner = await user();
        const source = await createPaymentIntake(ctx(owner), { amount: "200.00", receivedAt: "2026-09-21T12:05:00.000Z", attachmentRequirement: { expectedCount: 2 } });
        const sourceRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, source.publicId) });
        const file = await db.insert(files).values({ tenantId, ownerUserId: owner.id, bucket: "test", key: `replacement-${crypto.randomUUID()}`, originalName: "synthetic.png", mimeType: "image/png", size: 12, url: "storage:synthetic" }).returning().then((rows) => rows[0]!);
        await db.insert(paymentEvidence).values([
            { tenantId, paymentIntakeId: sourceRow!.id, fileId: file.id, status: "ready", evidenceType: "slip", evidenceHash: "b".repeat(64), mimeType: "image/png", declaredSize: 12, finalizedAt: new Date(), createdByUserId: owner.id, updatedByUserId: owner.id },
            { tenantId, paymentIntakeId: sourceRow!.id, fileId: null, status: "pending", evidenceType: "slip", evidenceHash: "c".repeat(64), mimeType: "image/png", declaredSize: 12, createdByUserId: owner.id, updatedByUserId: owner.id },
        ]);
        const requirement = await db.query.financialEvidenceRequirements.findFirst({ where: eq(financialEvidenceRequirements.paymentIntakeId, sourceRow!.id) });
        expect(requirement?.expectedCount).toBe(2);
        const capability = await getPaymentCancellationCapability(ctx(owner), source.publicId);
        await cancelPaymentIntake(ctx(owner), source.publicId, { reason: "incomplete evidence", idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash });
        const inspection = await inspectPaymentReplacement(ctx(owner), source.publicId);
        expect(inspection.allowed).toBe(false);
        expect(inspection.blockers).toContain("PAYMENT_REPLACEMENT_EVIDENCE_INCOMPLETE");
        await expect(createPaymentReplacement(ctx(owner), { paymentIntakePublicId: source.publicId, reason: "must stop", idempotencyKey: crypto.randomUUID(), expectedStateHash: inspection.stateHash })).rejects.toMatchObject({ code: "PAYMENT_REPLACEMENT_EVIDENCE_INCOMPLETE" });
    });

    integrationTest("returns pending and rejected evidence with safe metadata instead of hiding it", async () => {
        await reset();
        const owner = await user();
        const source = await createPaymentIntake(ctx(owner), { amount: "5.00", receivedAt: "2026-09-21T12:05:00.000Z" });
        const sourceRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, source.publicId) });
        await db.insert(paymentEvidence).values([
            { tenantId, paymentIntakeId: sourceRow!.id, status: "pending", evidenceType: "slip", mimeType: "image/png", declaredSize: 12, createdByUserId: owner.id, updatedByUserId: owner.id },
            { tenantId, paymentIntakeId: sourceRow!.id, status: "rejected", evidenceType: "slip", mimeType: "application/pdf", declaredSize: 42, createdByUserId: owner.id, updatedByUserId: owner.id },
        ]);
        const result = await getPaymentIntake(ctx(owner), source.publicId);
        expect(result.evidence).toHaveLength(2);
        expect(result.evidence.map((row) => ({ status: row.status, size: row.size, filePublicId: row.filePublicId }))).toEqual([
            { status: "pending", size: 12, filePublicId: null },
            { status: "rejected", size: 42, filePublicId: null },
        ]);
    });

    integrationTest("blocks a declared requirement when a ready evidence row has no actual file", async () => {
        await reset();
        const owner = await user();
        const source = await createPaymentIntake(ctx(owner), { amount: "6.00", receivedAt: "2026-09-21T12:05:00.000Z", attachmentRequirement: { expectedCount: 1 } });
        const sourceRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, source.publicId) });
        await db.insert(paymentEvidence).values({ tenantId, paymentIntakeId: sourceRow!.id, fileId: null, status: "ready", evidenceType: "slip", evidenceHash: "9".repeat(64), mimeType: "image/png", declaredSize: 12, finalizedAt: new Date(), createdByUserId: owner.id, updatedByUserId: owner.id });
        const capability = await getPaymentCancellationCapability(ctx(owner), source.publicId);
        await cancelPaymentIntake(ctx(owner), source.publicId, { reason: "missing file", idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash });
        const inspection = await inspectPaymentReplacement(ctx(owner), source.publicId);
        expect(inspection.allowed).toBe(false);
        expect(inspection.blockers).toContain("PAYMENT_REPLACEMENT_EVIDENCE_NOT_READY");
        await expect(createPaymentReplacement(ctx(owner), { paymentIntakePublicId: source.publicId, reason: "must stop", idempotencyKey: crypto.randomUUID(), expectedStateHash: inspection.stateHash })).rejects.toMatchObject({ code: "PAYMENT_REPLACEMENT_EVIDENCE_NOT_READY" });
    });

    integrationTest("blocks an unrelated semantic duplicate before replacement creation", async () => {
        await reset();
        const owner = await user();
        const source = await createPaymentIntake(ctx(owner), { amount: "25.00", receivedAt: "2026-09-21T12:05:00.000Z", payerName: "Same payer" });
        const sourceRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, source.publicId) });
        const file = await db.insert(files).values({ tenantId, ownerUserId: owner.id, bucket: "test", key: `duplicate-${crypto.randomUUID()}`, originalName: "synthetic.png", mimeType: "image/png", size: 12, url: "storage:synthetic" }).returning().then((rows) => rows[0]!);
        await db.insert(paymentEvidence).values({ tenantId, paymentIntakeId: sourceRow!.id, fileId: file.id, status: "ready", evidenceType: "slip", evidenceHash: "e".repeat(64), mimeType: "image/png", declaredSize: 12, finalizedAt: new Date(), createdByUserId: owner.id, updatedByUserId: owner.id });
        await createPaymentIntake(ctx(owner), { amount: "25.00", receivedAt: "2026-09-21T12:06:00.000Z", payerName: "Same payer" });
        const capability = await getPaymentCancellationCapability(ctx(owner), source.publicId);
        await cancelPaymentIntake(ctx(owner), source.publicId, { reason: "duplicate guard", idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash });
        const inspection = await inspectPaymentReplacement(ctx(owner), source.publicId);
        await expect(createPaymentReplacement(ctx(owner), { paymentIntakePublicId: source.publicId, reason: "must review", idempotencyKey: crypto.randomUUID(), expectedStateHash: inspection.stateHash })).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REQUIRES_REVIEW" });
    });

    integrationTest("reuses finalized evidence through an audited unposted chain and is idempotent", async () => {
        await reset();
        const owner = await user();
        const source = await createPaymentIntake(ctx(owner), { amount: "200.00", receivedAt: "2026-09-21T12:05:00.000Z", payerName: "Synthetic payer", bankReference: "bank-ref-chain" });
        const file = await db.insert(files).values({ tenantId, ownerUserId: owner.id, bucket: "test", key: `replacement-${crypto.randomUUID()}`, originalName: "synthetic.png", mimeType: "image/png", size: 12, url: "storage:synthetic" }).returning().then((rows) => rows[0]!);
        await db.insert(paymentEvidence).values({ tenantId, paymentIntakeId: (await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, source.publicId) }))!.id, fileId: file.id, status: "ready", evidenceType: "slip", evidenceHash: "a".repeat(64), mimeType: "image/png", declaredSize: 12, finalizedAt: new Date(), createdByUserId: owner.id, updatedByUserId: owner.id });
        const capability = await getPaymentCancellationCapability(ctx(owner), source.publicId);
        await cancelPaymentIntake(ctx(owner), source.publicId, { reason: "synthetic cancellation", idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash });
        const inspection = await inspectPaymentReplacement(ctx(owner), source.publicId);
        expect(inspection).toMatchObject({ allowed: true, blockers: [], replacementPaymentIntakePublicId: null });
        const request = { paymentIntakePublicId: source.publicId, reason: "correct contract mapping", idempotencyKey: crypto.randomUUID(), expectedStateHash: inspection.stateHash };
        const first = await createPaymentReplacement(ctx(owner), request);
        expect(first.status).toBe("draft");
        expect((await inspectPaymentReplacement(ctx(owner), source.publicId)).allowed).toBe(false);
        expect(await createPaymentReplacement(ctx(owner), request)).toEqual(first);
        expect(await db.select().from(paymentReplacementLineages)).toHaveLength(1);
        expect(await db.select().from(paymentReplacementEvidenceReferences)).toHaveLength(1);
        const lineageRow = (await db.select().from(paymentReplacementLineages))[0]!;
        const sourceEvidenceRow = (await db.select().from(paymentEvidence)).find((row) => row.paymentIntakeId !== null)!;
        const unrelated = await db.insert(paymentIntakes).values({ tenantId, ownerUserId: owner.id, amount: "200.00", receivedAt: new Date("2026-09-22T12:05:00.000Z"), status: "draft", createdByUserId: owner.id, updatedByUserId: owner.id }).returning().then((rows) => rows[0]!);
        await expect((async () => db.insert(paymentReplacementEvidenceReferences).values({ tenantId, lineageId: lineageRow.id, replacementPaymentIntakeId: (await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, first.replacementPaymentIntakePublicId) }))!.id, sourcePaymentIntakeId: unrelated.id, sourceEvidenceId: sourceEvidenceRow.id }).then(() => undefined))()).rejects.toThrow();
        await expect((async () => db.update(paymentIntakes).set({ replacementOfIntakeId: null }).where(eq(paymentIntakes.publicId, first.replacementPaymentIntakePublicId)).then(() => undefined))()).rejects.toThrow();
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, source.publicId) })).toMatchObject({ status: "cancelled", amount: "200.00", receivedAt: new Date("2026-09-21T12:05:00.000Z") });
        const child = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, first.replacementPaymentIntakePublicId) });
        expect(child).toMatchObject({ status: "draft", amount: "200.00", replacementOfIntakeId: expect.any(Number), receivedAt: new Date("2026-09-21T12:05:00.000Z") });
        const childWorkflow = await (await import("../mcp/workflow-resolver-service")).resolveWorkflowFromBackend({ ...ctx(owner), actorSource: "mcp" }, { intent: "receive_payment", target: { kind: "payment_intake", publicId: child!.publicId }, attachments: "none" }, "payments", "replacement-catalog", "replacement-workflow");
        expect(childWorkflow.observed.evidenceReady).toBe(true);
        await expect(preparePaymentEvidence(ctx(owner), child!.publicId, { mimeType: "image/png", size: 12, sha256: "a".repeat(64) }, { preparePut: async () => ({ uploadUrl: "unused", expiresAt: new Date(Date.now() + 60_000) }), head: async () => ({ exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} }) })).rejects.toMatchObject({ code: "PAYMENT_EVIDENCE_INHERITED" });
        const nextCapability = await getPaymentCancellationCapability(ctx(owner), child!.publicId);
        await cancelPaymentIntake(ctx(owner), child!.publicId, { reason: "second correction", idempotencyKey: crypto.randomUUID(), expectedStateHash: nextCapability.stateHash });
        const next = await inspectPaymentReplacement(ctx(owner), child!.publicId);
        expect(next.allowed).toBe(true);
        const third = await createPaymentReplacement(ctx(owner), { ...request, paymentIntakePublicId: child!.publicId, idempotencyKey: crypto.randomUUID(), expectedStateHash: next.stateHash });
        expect(third.status).toBe("draft");
        const lineages = await db.select().from(paymentReplacementLineages).orderBy(paymentReplacementLineages.id);
        expect(lineages).toHaveLength(2);
        expect(lineages[1]!.bankReferenceHash).toBe(lineages[0]!.bankReferenceHash);
        expect(await db.select().from(paymentEvidence).where(and(eq(paymentEvidence.tenantId, tenantId), eq(paymentEvidence.evidenceHash, "a".repeat(64))))).toHaveLength(1);
    });

    integrationTest("does not disclose a foreign tenant or viewer-owned source", async () => {
        await reset();
        const owner = await user();
        const viewer = await user("viewer");
        const source = await createPaymentIntake(ctx(owner), { amount: "1.00", receivedAt: "2026-09-21T12:05:00.000Z" });
        await expect(inspectPaymentReplacement({ ...ctx(viewer), tenantId }, source.publicId)).rejects.toMatchObject({ code: "PAYMENT_INTAKE_NOT_FOUND", status: 404 });
        await expect(inspectPaymentReplacement({ ...ctx(owner), tenantId: "other-tenant" }, source.publicId)).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    });

    integrationTest("serializes same-source retries and rejects a cross-source idempotency-key collision", async () => {
        await reset();
        const owner = await user();
        const makeCancelled = async (amount: string) => {
            const intake = await createPaymentIntake(ctx(owner), { amount, receivedAt: "2026-09-21T12:05:00.000Z" });
            const row = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
            const file = await db.insert(files).values({ tenantId, ownerUserId: owner.id, bucket: "test", key: `concurrent-${crypto.randomUUID()}`, originalName: "synthetic.png", mimeType: "image/png", size: 12, url: "storage:synthetic" }).returning().then((rows) => rows[0]!);
            await db.insert(paymentEvidence).values({ tenantId, paymentIntakeId: row!.id, fileId: file.id, status: "ready", evidenceType: "slip", evidenceHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "a").slice(0, 64), mimeType: "image/png", declaredSize: 12, finalizedAt: new Date(), createdByUserId: owner.id, updatedByUserId: owner.id });
            const capability = await getPaymentCancellationCapability(ctx(owner), intake.publicId);
            await cancelPaymentIntake(ctx(owner), intake.publicId, { reason: "synthetic", idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash });
            return intake;
        };
        const firstSource = await makeCancelled("10.00");
        const firstInspection = await inspectPaymentReplacement(ctx(owner), firstSource.publicId);
        const concurrent = await Promise.allSettled([
            createPaymentReplacement(ctx(owner), { paymentIntakePublicId: firstSource.publicId, reason: "one", idempotencyKey: "same-source-a", expectedStateHash: firstInspection.stateHash }),
            createPaymentReplacement(ctx(owner), { paymentIntakePublicId: firstSource.publicId, reason: "two", idempotencyKey: "same-source-b", expectedStateHash: firstInspection.stateHash }),
        ]);
        expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
        const secondSource = await makeCancelled("11.00");
        const thirdSource = await makeCancelled("12.00");
        const secondInspection = await inspectPaymentReplacement(ctx(owner), secondSource.publicId);
        const thirdInspection = await inspectPaymentReplacement(ctx(owner), thirdSource.publicId);
        const collision = await Promise.allSettled([
            createPaymentReplacement(ctx(owner), { paymentIntakePublicId: secondSource.publicId, reason: "other", idempotencyKey: "cross-source", expectedStateHash: secondInspection.stateHash }),
            createPaymentReplacement(ctx(owner), { paymentIntakePublicId: thirdSource.publicId, reason: "cross", idempotencyKey: "cross-source", expectedStateHash: thirdInspection.stateHash }),
        ]);
        expect(collision.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(collision.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect(collision.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }) });
    });

    integrationTest("previews and posts a standalone replacement across two installments, with stale duplicate recheck and concurrent idempotency", async () => {
        await reset();
        const owner = await user();
        const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: owner.id, name: "Standalone replacement borrower" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({ tenantId, ownerUserId: owner.id, borrowerId: borrower.id, principalAmount: "200.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "200.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then((rows) => rows[0]!);
        const schedules = await db.insert(loanSchedules).values([
            { tenantId, loanId: loan.id, installmentNo: 1, dueDate: "2026-09-20", scheduledPrincipal: "100.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "100.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "100.00", status: "pending" },
            { tenantId, loanId: loan.id, installmentNo: 2, dueDate: "2026-09-21", scheduledPrincipal: "100.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "100.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "100.00", status: "pending" },
        ]).returning();
        const source = await createPaymentIntake(ctx(owner), { amount: "200.00", receivedAt: "2026-09-21T12:05:00.000Z", payerName: "Standalone payer" });
        const sourceRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, source.publicId) });
        const file = await db.insert(files).values({ tenantId, ownerUserId: owner.id, bucket: "test", key: `standalone-${crypto.randomUUID()}`, originalName: "receipt.png", mimeType: "image/png", size: 20, url: "storage:test" }).returning().then((rows) => rows[0]!);
        await db.insert(paymentEvidence).values({ tenantId, paymentIntakeId: sourceRow!.id, fileId: file.id, status: "ready", evidenceType: "slip", evidenceHash: "f".repeat(64), mimeType: "image/png", declaredSize: 20, finalizedAt: new Date(), createdByUserId: owner.id, updatedByUserId: owner.id });
        const cancellation = await getPaymentCancellationCapability(ctx(owner), source.publicId);
        await cancelPaymentIntake(ctx(owner), source.publicId, { reason: "standalone correction", idempotencyKey: crypto.randomUUID(), expectedStateHash: cancellation.stateHash });
        const inspection = await inspectPaymentReplacement(ctx(owner), source.publicId);
        const replacement = await createPaymentReplacement(ctx(owner), { paymentIntakePublicId: source.publicId, reason: "standalone schedule mapping", idempotencyKey: crypto.randomUUID(), expectedStateHash: inspection.stateHash });
        const preview = await previewPaymentMatch(ctx(owner), replacement.replacementPaymentIntakePublicId, { allocations: schedules.map((schedule) => ({ borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, schedulePublicId: schedule.publicId, amount: "100.00" })) });
        expect(preview.status).toBe("ready");
        const child = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, replacement.replacementPaymentIntakePublicId) });
        await db.insert(paymentIntakes).values({ tenantId, ownerUserId: owner.id, amount: "200.00", receivedAt: new Date("2026-09-21T12:06:00.000Z"), payerName: "Standalone payer", status: "draft", createdByUserId: owner.id, updatedByUserId: owner.id });
        await expect(postPayment(ctx(owner), replacement.replacementPaymentIntakePublicId, { proposalPublicId: preview.publicId })).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REQUIRES_REVIEW" });
        expect(await db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.paymentIntakeId, child!.id)))).toHaveLength(0);
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, schedules[0]!.id) })).toMatchObject({ paidTotal: "0.00", remainingDue: "100.00" });
    });

    integrationTest("posts a standalone replacement exactly once when concurrent callers use the same proposal", async () => {
        await reset();
        const owner = await user();
        const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: owner.id, name: "Concurrent replacement borrower" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({ tenantId, ownerUserId: owner.id, borrowerId: borrower.id, principalAmount: "200.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "200.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then((rows) => rows[0]!);
        const schedules = await db.insert(loanSchedules).values([
            { tenantId, loanId: loan.id, installmentNo: 1, dueDate: "2026-09-20", scheduledPrincipal: "100.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "100.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "100.00", status: "pending" },
            { tenantId, loanId: loan.id, installmentNo: 2, dueDate: "2026-09-21", scheduledPrincipal: "100.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "100.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "100.00", status: "pending" },
        ]).returning();
        const source = await createPaymentIntake(ctx(owner), { amount: "200.00", receivedAt: "2026-09-21T12:05:00.000Z", payerName: "Concurrent payer" });
        const sourceRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, source.publicId) });
        const file = await db.insert(files).values({ tenantId, ownerUserId: owner.id, bucket: "test", key: `concurrent-post-${crypto.randomUUID()}`, originalName: "receipt.png", mimeType: "image/png", size: 20, url: "storage:test" }).returning().then((rows) => rows[0]!);
        await db.insert(paymentEvidence).values({ tenantId, paymentIntakeId: sourceRow!.id, fileId: file.id, status: "ready", evidenceType: "slip", evidenceHash: "1".repeat(64), mimeType: "image/png", declaredSize: 20, finalizedAt: new Date(), createdByUserId: owner.id, updatedByUserId: owner.id });
        const cancellation = await getPaymentCancellationCapability(ctx(owner), source.publicId);
        await cancelPaymentIntake(ctx(owner), source.publicId, { reason: "concurrent correction", idempotencyKey: crypto.randomUUID(), expectedStateHash: cancellation.stateHash });
        const inspection = await inspectPaymentReplacement(ctx(owner), source.publicId);
        const replacement = await createPaymentReplacement(ctx(owner), { paymentIntakePublicId: source.publicId, reason: "concurrent schedule mapping", idempotencyKey: crypto.randomUUID(), expectedStateHash: inspection.stateHash });
        const preview = await previewPaymentMatch(ctx(owner), replacement.replacementPaymentIntakePublicId, { allocations: schedules.map((schedule) => ({ borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, schedulePublicId: schedule.publicId, amount: "100.00" })) });
        const results = await Promise.all([postPayment(ctx(owner), replacement.replacementPaymentIntakePublicId, { proposalPublicId: preview.publicId }), postPayment({ ...ctx(owner), requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() }, replacement.replacementPaymentIntakePublicId, { proposalPublicId: preview.publicId })]);
        expect(results[0].status ?? results[1].status).toBe("posted");
        const child = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, replacement.replacementPaymentIntakePublicId) });
        expect(await db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.paymentIntakeId, child!.id), eq(transactions.entryType, "repayment")))).toHaveLength(2);
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, schedules[0]!.id) })).toMatchObject({ paidTotal: "100.00", remainingDue: "0.00", status: "paid" });
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, schedules[1]!.id) })).toMatchObject({ paidTotal: "100.00", remainingDue: "0.00", status: "paid" });
    });
});
