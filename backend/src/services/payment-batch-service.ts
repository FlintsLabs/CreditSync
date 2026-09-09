import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { borrowers, files, loans, paymentBatchAllocations, paymentBatchDecisions, paymentBatchDependencies, paymentBatchItems, paymentBatchOperationReceipts, paymentBatchPreviews, paymentBatches, paymentBatchStagingEvidence, paymentBatchStagingItems, paymentEvidence, paymentIntakes, paymentMatchProposals, loanSchedules } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { canAccessTenantWideData } from "../lib/access";
import { parseMoney, serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { normalizeBorrowerText } from "./borrower-service";
import { solvePaymentBatch } from "./payment-batch-solver";
import type { BatchObligation, BatchSlip, ExplicitBatchAllocation } from "./payment-batch-types";
import { evaluatePaymentChronology, type ChronologyItem, type PendingChronologyItem } from "./payment-chronology-guard";
import { assertPaymentBatchPreviewFresh } from "./payment-batch-execution-guard";
import { assertNoOlderPendingPayment, lockPaymentBorrowers, paymentIntakeBorrowerIds } from "./payment-chronology-service";
import { bangkokBusinessDate } from "./payment-chronology-guard";
import { planScheduledPayment } from "./payment-service";
import { assertPaymentEvidenceReady, finalizePaymentEvidence, normalizeBankReference, postPaymentAllocationInTransaction, preparePaymentEvidence, previewPaymentMatch, type EvidenceStorageGateway } from "./payment-service";
import { emptyFloatingBatchState, projectFloatingBatchPayment, type FloatingBatchState } from "./payment-batch-accounting-planner";
import { BUCKET_NAME, createSignedPutUrl, headStoredObject, toStorageReference } from "../lib/storage";

type BatchRow = typeof paymentBatches.$inferSelect;
type ItemRow = typeof paymentBatchItems.$inferSelect;
type ReceiptMetadata = { auditPublicId: string; correlationId: string };
type BatchExecutionReceipt = ReceiptMetadata & { batchPublicId: string; status: string; posted: Array<{ intakePublicId: string; transactionPublicIds: string[] }>; auditPublicIds: string[] };
function presentExecutionReceipt(receipt: BatchExecutionReceipt) {
    const { auditPublicId, ...result } = receipt;
    return { ...result, auditPublicIds: [...new Set([...result.auditPublicIds, auditPublicId])] };
}

async function operationReceipt<T extends object>(tx: DbExecutor, ctx: CommandContext, operationType: string, operationKey: string, requestHash: string): Promise<(T & ReceiptMetadata) | null> {
    const prior = await tx.query.paymentBatchOperationReceipts.findFirst({ where: and(eq(paymentBatchOperationReceipts.tenantId, ctx.tenantId), eq(paymentBatchOperationReceipts.operationType, operationType), eq(paymentBatchOperationReceipts.operationKey, operationKey)) });
    if (!prior) return null;
    const batch = await tx.query.paymentBatches.findFirst({ where: and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, prior.batchId)) });
    if (!batch) throw new DomainError("PAYMENT_BATCH_NOT_FOUND", "Payment batch not found", 404);
    await accessibleBatch(ctx, batch.publicId, tx);
    if (prior.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Batch idempotency key was reused with different data", 409);
    return prior.result as T & ReceiptMetadata;
}

async function recordOperation<T extends object>(tx: DbExecutor, ctx: CommandContext, batch: BatchRow, stagingItemId: number | null, operationType: string, operationKey: string, requestHash: string, value: T): Promise<T & ReceiptMetadata> {
    const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_batch", entityId: batch.publicId, action: operationType, payload: { operationType, requestHash } });
    const result = { ...value, auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    await tx.insert(paymentBatchOperationReceipts).values({ tenantId: ctx.tenantId, batchId: batch.id, stagingItemId, operationType, operationKey, requestHash, result, createdByUserId: ctx.actorUserId });
    return result;
}

function assertBatchEditable(batch: BatchRow) {
    if (["posted", "cancelled"].includes(batch.status)) throw new DomainError("PAYMENT_BATCH_NOT_EDITABLE", "Posted or cancelled batches cannot be changed", 409);
}

async function lockedStagingItem(ctx: CommandContext, publicId: string, tx: DbExecutor) {
    const accessible = await accessibleStagingItem(ctx, publicId, tx);
    await tx.execute(sql`SELECT id FROM payment_batches WHERE tenant_id = ${ctx.tenantId} AND id = ${accessible.batch.id} FOR UPDATE`);
    const result = await accessibleStagingItem(ctx, publicId, tx);
    return result;
}

function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value, (_key, item) => item !== null && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex"); }
type AllocationSemantics = Pick<typeof paymentBatchAllocations.$inferInsert, "itemId" | "borrowerId" | "loanId" | "scheduleId" | "allocationOrder" | "amount" | "targetDueDate" | "intent" | "targetKind" | "floatingPlan" | "calculatedComponents">;
function allocationSnapshotHash(rows: AllocationSemantics[], postingSequence: string[]) {
    return `v1:${digest({ postingSequence, allocations: rows.map((row) => ({ itemId: row.itemId, borrowerId: row.borrowerId, loanId: row.loanId, scheduleId: row.scheduleId ?? null, allocationOrder: row.allocationOrder, amount: row.amount, targetDueDate: row.targetDueDate, intent: row.intent, targetKind: row.targetKind, floatingPlan: row.floatingPlan ?? null, calculatedComponents: row.calculatedComponents })) })}`;
}
// Hash only: raw accounting/evidence rows never leave the service or enter logs.
// Include append-only history as well as mutable balances so a reversal or a
// newly finalized evidence file invalidates an otherwise identical preview.
async function batchSnapshot(executor: DbExecutor, tenantId: string, batchId: number, borrowerIds: number[]) {
    const rows = await executor.execute(sql`
        SELECT jsonb_build_object(
            'items', (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]') FROM payment_batch_items i WHERE i.tenant_id = ${tenantId} AND i.batch_id = ${batchId}),
            'intakes', (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]') FROM payment_intakes i WHERE i.tenant_id = ${tenantId} AND i.id IN (SELECT payment_intake_id FROM payment_batch_items WHERE tenant_id = ${tenantId} AND batch_id = ${batchId})),
            'evidence', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]') FROM payment_evidence e WHERE e.tenant_id = ${tenantId} AND e.payment_intake_id IN (SELECT payment_intake_id FROM payment_batch_items WHERE tenant_id = ${tenantId} AND batch_id = ${batchId}))
        ) AS snapshot`);
    const loanRows = await executor.select().from(loans).where(and(eq(loans.tenantId, tenantId), inArray(loans.borrowerId, borrowerIds))).orderBy(asc(loans.id));
    const history: unknown[] = [];
    for (const table of ["loan_schedules", "transactions", "loan_interest_rate_periods", "loan_interest_accruals", "floating_transaction_allocations", "floating_penalty_ledger_entries"]) {
        if (!loanRows.length) break;
        history.push(await executor.execute(sql`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]') AS rows FROM ${sql.identifier(table)} r WHERE r.tenant_id = ${tenantId} AND r.loan_id IN (${sql.join(loanRows.map((loan) => sql`${loan.id}`), sql`, `)})`));
    }
    return `v2:${digest({ membership: Array.from(rows), loans: loanRows, history: history.map((rows) => Array.from(rows as Iterable<unknown>)) })}`;
}
function digestBankReference(value: string) { return createHash("sha256").update(value).digest("hex"); }
function requireId(value: string, field: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400);
}
async function actor(ctx: CommandContext, executor: DbExecutor = db) {
    if (ctx.actorUserId === null) return null;
    const user = await executor.query.users.findFirst({ where: (users: any, { and, eq }: any) => and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)) });
    if (!user) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return user;
}
async function assertBorrowerPortfolio(ctx: CommandContext, selected: Array<typeof borrowers.$inferSelect>, executor: DbExecutor) {
    const user = await actor(ctx, executor);
    if (user && !canAccessTenantWideData({ role: user.role ?? "viewer" }) && selected.some((borrower) => borrower.ownerUserId !== user.id)) throw new DomainError("BORROWER_NOT_FOUND", "Selected borrower is outside the actor portfolio", 404);
}
async function accessibleBatch(ctx: CommandContext, publicId: string, executor: DbExecutor = db): Promise<BatchRow> {
    requireId(publicId, "batchPublicId");
    const row = await executor.query.paymentBatches.findFirst({ where: (batches: any, { and, eq }: any) => and(eq(batches.tenantId, ctx.tenantId), eq(batches.publicId, publicId)) });
    if (!row) throw new DomainError("PAYMENT_BATCH_NOT_FOUND", "Payment batch not found", 404);
    const user = await actor(ctx, executor);
    if (user && !canAccessTenantWideData({ role: user.role ?? "viewer" }) && row.createdByUserId !== user.id) throw new DomainError("PAYMENT_BATCH_NOT_FOUND", "Payment batch not found", 404);
    return row;
}
function presentBatch(row: BatchRow, items: Array<ItemRow & { intakePublicId?: string; evidenceStatus?: string | null }> = [], latestPreview: unknown = null) {
    return { id: row.publicId, publicId: row.publicId, status: row.status, version: row.version, borrowerPublicId: null, stateHash: row.stateHash, confirmationHash: row.confirmationHash, confirmedVersion: row.confirmedVersion, notes: row.notes, items: items.map((item) => ({ id: item.publicId, publicId: item.publicId, itemOrder: item.itemOrder, paymentIntakePublicId: item.intakePublicId ?? null, evidenceStatus: item.evidenceStatus ?? null })), latestPreview, postedAt: row.postedAt, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
async function view(ctx: CommandContext, row: BatchRow, executor: DbExecutor = db) {
    const items = await executor.select().from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, row.id))).orderBy(asc(paymentBatchItems.itemOrder));
    const intakes = items.length ? await executor.select().from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, items.map((item) => item.paymentIntakeId)))) : [];
    const latest = await executor.select().from(paymentBatchPreviews).where(and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), eq(paymentBatchPreviews.batchId, row.id))).orderBy(desc(paymentBatchPreviews.version)).limit(1);
    return presentBatch(row, items.map((item) => ({ ...item, intakePublicId: intakes.find((intake) => intake.id === item.paymentIntakeId)?.publicId })), latest[0] ? { id: latest[0].publicId, version: latest[0].version, status: latest[0].status, previewHash: latest[0].previewHash, confirmationHash: latest[0].confirmationHash, warnings: latest[0].warnings, candidates: latest[0].candidates } : null);
}

async function accessibleStagingItem(ctx: CommandContext, publicId: string, executor: DbExecutor = db) {
    requireId(publicId, "stagingItemPublicId");
    const staging = await executor.query.paymentBatchStagingItems.findFirst({ where: and(eq(paymentBatchStagingItems.tenantId, ctx.tenantId), eq(paymentBatchStagingItems.publicId, publicId)) });
    if (!staging) throw new DomainError("PAYMENT_BATCH_STAGING_NOT_FOUND", "Staging item not found", 404);
    const batch = await executor.query.paymentBatches.findFirst({ where: and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, staging.batchId)) });
    if (!batch) throw new DomainError("PAYMENT_BATCH_NOT_FOUND", "Payment batch not found", 404);
    await accessibleBatch(ctx, batch.publicId, executor);
    return { staging, batch };
}

async function assertBatchStagingComplete(ctx: CommandContext, batch: BatchRow, executor: DbExecutor) {
    const staging = await executor.select().from(paymentBatchStagingItems).where(and(eq(paymentBatchStagingItems.tenantId, ctx.tenantId), eq(paymentBatchStagingItems.batchId, batch.id)));
    if (!staging.length) return;
    if (staging.some((item) => item.status !== "validated" || item.paymentIntakeId === null || item.batchItemId === null)) {
        throw new DomainError("PAYMENT_BATCH_STAGING_INCOMPLETE", "Every staged batch member must be reviewed before preview or execute", 409);
    }
    // Upload-first review always creates an evidence-required intake and links
    // its finalized staging evidence. Existing data-only capture remains valid;
    // once evidence is requested the same intake readiness gate applies.
    for (const item of staging) {
        const intake = await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, item.paymentIntakeId!)) });
        if (!intake) throw new DomainError("PAYMENT_BATCH_STAGING_INCOMPLETE", "Reviewed staging intake is missing", 409);
        await assertPaymentEvidenceReady(executor, ctx.tenantId, intake);
    }
}

function stagingEvidenceInputValid(input: Pick<BatchStagingEvidenceInput, "mimeType" | "size" | "sha256">) {
    const maxBytes = Math.max(1, Number(process.env.EVIDENCE_MAX_BYTES ?? 20 * 1024 * 1024));
    if (!["image/jpeg", "image/png", "application/pdf"].includes(input.mimeType) || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > maxBytes || !/^[0-9a-f]{64}$/i.test(input.sha256)) {
        throw new DomainError("INVALID_EVIDENCE", "Evidence must be JPEG, PNG, or PDF with a valid size and SHA-256", 400);
    }
}

async function inspectBatchChronology(
    ctx: CommandContext,
    batch: BatchRow,
    borrowerPublicId: string,
    currentItems: Array<typeof paymentBatchItems.$inferSelect>,
    currentIntakes: Array<typeof paymentIntakes.$inferSelect>,
    evidence: Array<typeof paymentEvidence.$inferSelect>,
    executor: DbExecutor,
) {
    const borrower = await executor.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, borrowerPublicId)) });
    if (!borrower) return null;
    const allMembers = await executor.select({ paymentIntakeId: paymentBatchItems.paymentIntakeId }).from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, batch.id)));
    for (const intake of currentIntakes) await assertNoOlderPendingPayment(executor, ctx.tenantId, borrower.id, intake.receivedAt, allMembers.map((row) => row.paymentIntakeId));
    const pendingBatches = await executor.select().from(paymentBatches).where(and(eq(paymentBatches.tenantId, ctx.tenantId), sql`${paymentBatches.status} NOT IN ('posted', 'cancelled')`));
    const otherBatches = pendingBatches.filter((candidate) => candidate.id !== batch.id);
    const otherBatchIds = otherBatches.map((candidate) => candidate.id);
    const otherItems = otherBatchIds.length ? await executor.select().from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), inArray(paymentBatchItems.batchId, otherBatchIds))) : [];
    const otherStaging = otherItems.length ? await executor.select().from(paymentBatchStagingItems).where(and(eq(paymentBatchStagingItems.tenantId, ctx.tenantId), inArray(paymentBatchStagingItems.batchItemId, otherItems.map((item) => item.id)))) : [];
    const otherAllocations = otherBatchIds.length ? await executor.select({ itemId: paymentBatchItems.id, borrowerId: paymentBatchAllocations.borrowerId }).from(paymentBatchAllocations)
        .innerJoin(paymentBatchItems, and(eq(paymentBatchItems.tenantId, paymentBatchAllocations.tenantId), eq(paymentBatchItems.id, paymentBatchAllocations.itemId)))
        .innerJoin(paymentBatches, and(eq(paymentBatches.tenantId, paymentBatchItems.tenantId), eq(paymentBatches.id, paymentBatchItems.batchId)))
        .innerJoin(paymentBatchPreviews, and(eq(paymentBatchPreviews.tenantId, paymentBatches.tenantId), eq(paymentBatchPreviews.id, paymentBatchAllocations.previewId), eq(paymentBatchPreviews.batchId, paymentBatches.id), eq(paymentBatchPreviews.status, "ready"), eq(paymentBatchPreviews.id, sql`(SELECT latest.id FROM payment_batch_previews latest WHERE latest.tenant_id = ${ctx.tenantId} AND latest.batch_id = ${paymentBatches.id} ORDER BY latest.version DESC LIMIT 1)`)))
        .where(and(eq(paymentBatchAllocations.tenantId, ctx.tenantId), inArray(paymentBatchItems.batchId, otherBatchIds))) : [];
    const otherMappedLoanIds = otherStaging.flatMap((item) => item.reviewedMapping?.loanPublicId ? [item.reviewedMapping.loanPublicId] : []);
    const otherMappedLoans = otherMappedLoanIds.length ? await executor.select().from(loans).where(and(eq(loans.tenantId, ctx.tenantId), inArray(loans.publicId, otherMappedLoanIds))) : [];
    const allIntakeIds = [...otherItems.map((item) => item.paymentIntakeId), ...currentIntakes.map((intake) => intake.id)];
    const allIntakes = allIntakeIds.length ? await executor.select().from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, allIntakeIds))) : [];
    const standalone = await executor.select({ intake: paymentIntakes }).from(paymentIntakes).innerJoin(loans, eq(paymentIntakes.originLoanId, loans.id)).where(and(
        eq(paymentIntakes.tenantId, ctx.tenantId), eq(loans.tenantId, ctx.tenantId), eq(loans.borrowerId, borrower.id),
        sql`NOT EXISTS (SELECT 1 FROM payment_batch_items AS batch_item WHERE batch_item.tenant_id = ${ctx.tenantId} AND batch_item.payment_intake_id = ${paymentIntakes.id})`,
    ));
    const pending: PendingChronologyItem[] = [...otherItems.flatMap((item) => {
        const intake = allIntakes.find((candidate) => candidate.id === item.paymentIntakeId);
        const staging = otherStaging.find((candidate) => candidate.batchItemId === item.id);
        const mappedBorrowerId = staging?.reviewedMapping?.borrowerPublicId === borrower.publicId
            ? borrower.id
            : otherMappedLoans.find((loan) => loan.publicId === staging?.reviewedMapping?.loanPublicId)?.borrowerId;
        const ownerBatch = otherBatches.find((candidate) => candidate.id === item.batchId);
        const currentAllocation = otherAllocations.find((allocation) => allocation.itemId === item.id);
        const resolvedBorrowerId = staging
            ? (staging.resolutionState === "cleared" ? undefined : staging.reviewedMapping ? mappedBorrowerId : currentAllocation?.borrowerId ?? ownerBatch?.borrowerId)
            : ownerBatch?.borrowerId;
        return intake && resolvedBorrowerId === borrower.id ? [{ itemId: item.publicId, borrowerId: borrower.publicId, receivedAt: intake.receivedAt.toISOString(), status: intake.status }] : [];
    }), ...standalone.map(({ intake }) => ({ itemId: intake.publicId, borrowerId: borrower.publicId, receivedAt: intake.receivedAt?.toISOString() ?? null, status: intake.status }))];
    const incoming: ChronologyItem[] = currentItems.flatMap((item) => {
        const intake = currentIntakes.find((candidate) => candidate.id === item.paymentIntakeId);
        return intake ? [{ itemId: item.publicId, borrowerId: borrower.publicId, receivedAt: intake.receivedAt.toISOString(), evidenceReady: !intake.evidenceRequired || evidence.some((entry) => entry.paymentIntakeId === intake.id && entry.status === "ready" && entry.finalizedAt !== null) }] : [];
    });
    return evaluatePaymentChronology({ now: new Date().toISOString(), borrowerId: borrower.publicId, pending, incoming });
}

export async function createPaymentBatch(ctx: CommandContext, input: { idempotencyKey: string; borrowerPublicId?: string | null; notes?: string | null }) {
    await actor(ctx);
    const key = input.idempotencyKey.trim();
    if (!key) throw new DomainError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey must not be blank", 400);
    const existing = await db.query.paymentBatches.findFirst({ where: and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.createIdempotencyKey, key)) });
    if (existing) return view(ctx, await accessibleBatch(ctx, existing.publicId));
    let borrowerId: number | null = null;
    if (input.borrowerPublicId) {
        requireId(input.borrowerPublicId, "borrowerPublicId");
        const borrower = await db.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, input.borrowerPublicId)) });
        if (!borrower) throw new DomainError("BORROWER_NOT_FOUND", "Borrower not found", 404);
        await assertBorrowerPortfolio(ctx, [borrower], db);
        borrowerId = borrower.id;
    }
    const created = await db.transaction(async (tx) => {
        const row = await tx.insert(paymentBatches).values({ tenantId: ctx.tenantId, borrowerId, status: borrowerId ? "draft" : "needs_review", version: 0, stateHash: digest({ borrowerPublicId: input.borrowerPublicId ?? null, items: [] }), createIdempotencyKey: key, notes: input.notes ?? null, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_batch", entityId: row.publicId, action: "created", payload: { batchPublicId: row.publicId } });
        return row;
    });
    return view(ctx, created);
}

export type CapturePaymentBatchItemInput = {
    clientItemKey: string;
    amount: string;
    receivedAt: string;
    payerName?: string | null;
    bankReference?: string | null;
    intakeIdempotencyKey: string;
};

export type StagePaymentBatchItemInput = {
    clientItemKey: string;
    payerName?: string | null;
    bankReference?: string | null;
};
type StagedBatchResult = { batchPublicId: string; status: string; items: Array<{ publicId: string; clientItemKey: string; status: string }> };

/** Creates resumable batch membership without inventing OCR amount or transfer time. */
export async function stagePaymentBatchItems(ctx: CommandContext, input: {
    idempotencyKey: string;
    borrowerPublicId?: string | null;
    notes?: string | null;
    items: StagePaymentBatchItemInput[];
}) {
    if (!input.idempotencyKey.trim()) throw new DomainError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey must not be blank", 400);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) throw new DomainError("INVALID_BATCH_ITEMS", "Payment batch must contain 1 to 50 items", 400);
    const keys = input.items.map((item) => item.clientItemKey.trim());
    if (keys.some((key) => !key) || new Set(keys).size !== keys.length) throw new DomainError("DUPLICATE_BATCH_ITEM_KEY", "Batch item keys must be unique and non-blank", 400);
    const normalized = input.items.map((item) => ({ clientItemKey: item.clientItemKey.trim(), payerName: item.payerName?.trim() || null, bankReferenceHash: item.bankReference?.trim() ? digestBankReference(normalizeBankReference(item.bankReference.trim())) : null })).sort((a, b) => a.clientItemKey.localeCompare(b.clientItemKey));
    const key = input.idempotencyKey.trim();
    const requestHash = digest({ borrowerPublicId: input.borrowerPublicId ?? null, notes: input.notes?.trim() || null, items: normalized });
    return db.transaction(async (tx) => {
        await actor(ctx, tx);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:batch-create:${key}`}, 0))`);
        const prior = await operationReceipt<StagedBatchResult>(tx, ctx, "batch.stage", key, requestHash);
        if (prior) return prior;
        const existingBatch = await tx.query.paymentBatches.findFirst({ where: and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.createIdempotencyKey, key)) });
        if (existingBatch) {
            await accessibleBatch(ctx, existingBatch.publicId, tx);
            throw new DomainError("IDEMPOTENCY_CONFLICT", "Batch idempotency key is already used by another capture operation", 409);
        }
        let borrowerId: number | null = null;
        if (input.borrowerPublicId) {
            requireId(input.borrowerPublicId, "borrowerPublicId");
            const borrower = await tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, input.borrowerPublicId)) });
            if (!borrower) throw new DomainError("BORROWER_NOT_FOUND", "Borrower not found", 404);
            await assertBorrowerPortfolio(ctx, [borrower], tx);
            borrowerId = borrower.id;
        }
        const [row] = await tx.insert(paymentBatches).values({ tenantId: ctx.tenantId, borrowerId, status: "draft", version: 1, stateHash: requestHash, createIdempotencyKey: key, notes: input.notes?.trim() || null, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning();
        if (!row) throw new Error("Batch insert did not return a row");
        const result = [] as Array<{ publicId: string; clientItemKey: string; status: string }>;
        for (const item of normalized) {
            const created = await tx.insert(paymentBatchStagingItems).values({ ...item, tenantId: ctx.tenantId, batchId: row.id, payloadFingerprint: digest(item), status: "staged", createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((values) => values[0]!);
            result.push({ publicId: created.publicId, clientItemKey: created.clientItemKey, status: created.status });
        }
        return recordOperation(tx, ctx, row, null, "batch.stage", key, requestHash, { batchPublicId: row.publicId, status: row.status, items: result });
    });
}

type BatchStagingEvidenceInput = { stagingItemPublicId: string; mimeType: string; size: number; sha256: string; originalName?: string | null };

export async function preparePaymentBatchStagingEvidence(ctx: CommandContext, input: BatchStagingEvidenceInput, gateway: EvidenceStorageGateway = { preparePut: createSignedPutUrl, head: headStoredObject }) {
    stagingEvidenceInputValid(input);
    return db.transaction(async (tx) => {
    const { staging, batch } = await lockedStagingItem(ctx, input.stagingItemPublicId, tx);
    const requestHash = digest({ stagingItemPublicId: staging.publicId, mimeType: input.mimeType, size: input.size, sha256: input.sha256.toLowerCase() });
    const prior = await operationReceipt<{ evidencePublicId: string; stagingItemPublicId: string; status: string }>(tx, ctx, "staging.evidence.prepare", staging.publicId, requestHash);
    const existing = await tx.query.paymentBatchStagingEvidence.findFirst({ where: and(eq(paymentBatchStagingEvidence.tenantId, ctx.tenantId), eq(paymentBatchStagingEvidence.stagingItemId, staging.id)) });
    if (existing && (existing.evidenceHash !== input.sha256.toLowerCase() || existing.mimeType !== input.mimeType || existing.declaredSize !== input.size)) throw new DomainError("STAGING_EVIDENCE_HASH_CONFLICT", "Staging evidence metadata cannot be changed", 409);
    if (existing?.status === "ready") return { ...prior, evidencePublicId: existing.publicId, stagingItemPublicId: staging.publicId, status: existing.status, immutable: true };
    assertBatchEditable(batch);
    if (existing && existing.status !== "pending") throw new DomainError("STAGING_EVIDENCE_NOT_PENDING", "Rejected evidence cannot receive another upload", 409);
    const current = existing ?? await (async () => {
        const key = `payment-batch-staging/${ctx.tenantId}/${staging.publicId}/${crypto.randomUUID()}`;
        const file = await tx.insert(files).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, bucket: BUCKET_NAME, key, originalName: input.originalName?.trim() || null, mimeType: input.mimeType, size: input.size, url: toStorageReference({ provider: "s3", bucket: BUCKET_NAME, key }) }).returning().then((values) => values[0]!);
        return tx.insert(paymentBatchStagingEvidence).values({ tenantId: ctx.tenantId, stagingItemId: staging.id, fileId: file.id, evidenceHash: input.sha256.toLowerCase(), mimeType: input.mimeType, declaredSize: input.size, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((values) => values[0]!);
    })();
    if (!current) throw new DomainError("STAGING_EVIDENCE_NOT_FOUND", "Staging evidence could not be created", 500);
    const file = await tx.query.files.findFirst({ where: and(eq(files.tenantId, ctx.tenantId), eq(files.id, current.fileId)) });
    if (!file) throw new DomainError("STAGING_EVIDENCE_FILE_NOT_FOUND", "Staging evidence file not found", 404);
    const signed = await gateway.preparePut({ bucket: file.bucket, key: file.key, contentType: current.mimeType, contentLength: current.declaredSize, checksumSha256: current.evidenceHash, metadata: { tenant: ctx.tenantId, staging: staging.publicId } });
    await tx.update(paymentBatchStagingEvidence).set({ uploadExpiresAt: signed.expiresAt, updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentBatchStagingEvidence.tenantId, ctx.tenantId), eq(paymentBatchStagingEvidence.id, current.id)));
    const receipt = prior ?? await recordOperation(tx, ctx, batch, staging.id, "staging.evidence.prepare", staging.publicId, requestHash, { evidencePublicId: current.publicId, stagingItemPublicId: staging.publicId, status: current.status });
    // Signed credentials are transient and deliberately excluded from durable receipts/audit.
    return { ...receipt, uploadUrl: signed.uploadUrl, expiresAt: signed.expiresAt, requiredHeaders: signed.requiredHeaders };
    });
}

export async function finalizePaymentBatchStagingEvidence(ctx: CommandContext, stagingItemPublicId: string, evidencePublicId: string, gateway: EvidenceStorageGateway = { preparePut: createSignedPutUrl, head: headStoredObject }) {
    requireId(evidencePublicId, "evidencePublicId");
    return db.transaction(async (tx) => {
    const { staging, batch } = await lockedStagingItem(ctx, stagingItemPublicId, tx);
    const requestHash = digest({ stagingItemPublicId, evidencePublicId });
    const prior = await operationReceipt<{ evidencePublicId: string; status: string; sha256: string }>(tx, ctx, "staging.evidence.finalize", evidencePublicId, requestHash);
    if (prior) return prior;
    assertBatchEditable(batch);
    const row = await tx.query.paymentBatchStagingEvidence.findFirst({ where: and(eq(paymentBatchStagingEvidence.tenantId, ctx.tenantId), eq(paymentBatchStagingEvidence.publicId, evidencePublicId), eq(paymentBatchStagingEvidence.stagingItemId, staging.id)) });
    if (!row) throw new DomainError("PAYMENT_BATCH_STAGING_NOT_FOUND", "Staging evidence not found", 404);
    if (row.status !== "pending") throw new DomainError("EVIDENCE_FINALIZE_CONFLICT", "Evidence has no matching finalize receipt", 409);
    const file = await tx.query.files.findFirst({ where: and(eq(files.tenantId, ctx.tenantId), eq(files.id, row.fileId)) });
    if (!file) throw new DomainError("STAGING_EVIDENCE_FILE_NOT_FOUND", "Staging evidence file not found", 404);
    if (!row.uploadExpiresAt || row.uploadExpiresAt.getTime() <= Date.now()) throw new DomainError("EVIDENCE_UPLOAD_EXPIRED", "Staging evidence upload has expired", 409);
    const head = await gateway.head(file.key, file.bucket);
    if (!head.exists || head.contentType !== row.mimeType || head.contentLength !== row.declaredSize || head.checksumSha256?.toLowerCase() !== row.evidenceHash || head.metadata.tenant !== ctx.tenantId || head.metadata.staging !== staging.publicId) throw new DomainError("EVIDENCE_METADATA_MISMATCH", "Staging evidence metadata does not match", 409);
    if (row.uploadExpiresAt.getTime() <= Date.now()) throw new DomainError("EVIDENCE_UPLOAD_EXPIRED", "Staging evidence upload has expired", 409);
    const updated = await tx.update(paymentBatchStagingEvidence).set({ status: "ready", finalizedAt: new Date(), updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentBatchStagingEvidence.tenantId, ctx.tenantId), eq(paymentBatchStagingEvidence.id, row.id), eq(paymentBatchStagingEvidence.status, "pending"))).returning().then((values) => values[0]);
    if (!updated) throw new DomainError("EVIDENCE_FINALIZE_CONFLICT", "Staging evidence can no longer be finalized", 409);
    return recordOperation(tx, ctx, batch, staging.id, "staging.evidence.finalize", evidencePublicId, requestHash, { evidencePublicId: updated.publicId, status: updated.status, sha256: updated.evidenceHash });
    });
}

export async function reviewPaymentBatchStagingItem(ctx: CommandContext, input: { stagingItemPublicId: string; amount: string; receivedAt: string; intakeIdempotencyKey: string; reviewedReason?: string; reviewedRangeFrom?: string; reviewedRangeTo?: string }) {
    const amount = parseMoney(input.amount);
    if (amount.lte(0)) throw new DomainError("INVALID_PAYMENT_AMOUNT", "Payment amount must be positive", 400);
    const receivedAt = new Date(input.receivedAt);
    if (Number.isNaN(receivedAt.getTime())) throw new DomainError("INVALID_RECEIVED_AT", "receivedAt must be an ISO date-time", 400);
    if (!input.intakeIdempotencyKey.trim()) throw new DomainError("INVALID_IDEMPOTENCY_KEY", "intakeIdempotencyKey must not be blank", 400);
    return db.transaction(async (tx) => {
        const preliminary = await accessibleStagingItem(ctx, input.stagingItemPublicId, tx);
        const borrowerIds = [preliminary.batch.borrowerId].filter((id): id is number => id !== null);
        const mapping = preliminary.staging.reviewedMapping;
        const mappedLoan = mapping?.loanPublicId ? await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, mapping.loanPublicId)) }) : null;
        const mappedBorrower = mapping?.borrowerPublicId ? await tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, mapping.borrowerPublicId)) }) : mappedLoan ? await tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.id, mappedLoan.borrowerId)) }) : null;
        if (mappedBorrower) borrowerIds.push(mappedBorrower.id);
        if (preliminary.staging.paymentIntakeId) borrowerIds.push(...await paymentIntakeBorrowerIds(tx, ctx.tenantId, preliminary.staging.paymentIntakeId));
        await lockPaymentBorrowers(tx, ctx.tenantId, borrowerIds);
        const { staging, batch } = await lockedStagingItem(ctx, input.stagingItemPublicId, tx);
        if (!batch || !staging) throw new DomainError("PAYMENT_BATCH_STAGING_NOT_FOUND", "Staging item not found", 404);
        const requestHash = digest({ stagingItemPublicId: staging.publicId, amount: serializeMoney(amount), receivedAt: receivedAt.toISOString(), intakeIdempotencyKey: input.intakeIdempotencyKey.trim(), reviewedReason: input.reviewedReason?.trim() || null, reviewedRangeFrom: input.reviewedRangeFrom || null, reviewedRangeTo: input.reviewedRangeTo || null });
        const existingReceipt = await tx.query.paymentBatchOperationReceipts.findFirst({ where: and(eq(paymentBatchOperationReceipts.tenantId, ctx.tenantId), eq(paymentBatchOperationReceipts.operationType, "staging.review"), eq(paymentBatchOperationReceipts.operationKey, input.intakeIdempotencyKey.trim())) });
        if (existingReceipt) {
            if (existingReceipt.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Review idempotency key was reused with different data", 409);
            return existingReceipt.result;
        }
        if (staging.revision !== preliminary.staging.revision || digest(staging.reviewedMapping) !== digest(preliminary.staging.reviewedMapping) || staging.resolutionState !== preliminary.staging.resolutionState || batch.version !== preliminary.batch.version) throw new DomainError("STAGING_MAPPING_STALE", "Staging mapping changed while review was waiting for its locks; inspect and retry", 409);
        assertBatchEditable(batch);
        if (staging.status === "validated" || staging.paymentIntakeId || staging.batchItemId) throw new DomainError("PAYMENT_BATCH_STAGING_REVIEW_CONFLICT", "Staging item was already reviewed without a matching receipt", 409);
        const evidence = await tx.query.paymentBatchStagingEvidence.findFirst({ where: and(eq(paymentBatchStagingEvidence.tenantId, ctx.tenantId), eq(paymentBatchStagingEvidence.stagingItemId, staging.id), eq(paymentBatchStagingEvidence.status, "ready")) });
        if (!evidence) throw new DomainError("EVIDENCE_REQUIRED_NOT_READY", "Finalize staging evidence before review", 409);
        const reviewMappedLoan = staging.reviewedMapping?.loanPublicId ? await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, staging.reviewedMapping.loanPublicId)) }) : null;
        if (staging.reviewedMapping?.loanPublicId && !reviewMappedLoan) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Mapped loan is unavailable", 409);
        const reviewMappedBorrower = staging.reviewedMapping?.borrowerPublicId ? await tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, staging.reviewedMapping.borrowerPublicId)) }) : reviewMappedLoan ? await tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.id, reviewMappedLoan.borrowerId)) }) : null;
        if (staging.reviewedMapping?.borrowerPublicId && !reviewMappedBorrower) throw new DomainError("BORROWER_NOT_FOUND", "Mapped borrower is unavailable", 404);
        if (reviewMappedLoan) {
            const mappedBorrower = await tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.id, reviewMappedLoan.borrowerId)) });
            if (!mappedBorrower) throw new DomainError("BORROWER_NOT_FOUND", "Mapped borrower is unavailable", 404);
            await assertBorrowerPortfolio(ctx, [mappedBorrower], tx);
        }
        if (reviewMappedBorrower) await assertBorrowerPortfolio(ctx, [reviewMappedBorrower], tx);
        const batchItems = await tx.select().from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, staging.batchId))).orderBy(desc(paymentBatchItems.itemOrder));
        const intake = await tx.insert(paymentIntakes).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, source: ctx.actorSource === "mcp" ? "mcp" : "web", status: "draft", amount: serializeMoney(amount), receivedAt, originLoanId: reviewMappedLoan?.id ?? null, payerName: staging.payerName, bankReferenceHash: staging.bankReferenceHash, evidenceRequired: true, idempotencyKey: input.intakeIdempotencyKey.trim(), createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((values) => values[0]!);
        await tx.insert(paymentEvidence).values({ tenantId: ctx.tenantId, paymentIntakeId: intake.id, fileId: evidence.fileId, evidenceType: "slip", status: "ready", evidenceHash: evidence.evidenceHash, mimeType: evidence.mimeType, declaredSize: evidence.declaredSize, finalizedAt: evidence.finalizedAt, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId });
        const batchItem = await tx.insert(paymentBatchItems).values({ tenantId: ctx.tenantId, batchId: staging.batchId, paymentIntakeId: intake.id, stagingItemId: staging.id, itemOrder: (batchItems[0]?.itemOrder ?? 0) + 1 }).returning().then((values) => values[0]!);
        const updated = await tx.update(paymentBatchStagingItems).set({ amount: serializeMoney(amount), receivedAt, status: "validated", revision: staging.revision + 1, paymentIntakeId: intake.id, batchItemId: batchItem.id, reviewedReason: input.reviewedReason?.trim() || null, reviewedRangeFrom: input.reviewedRangeFrom || null, reviewedRangeTo: input.reviewedRangeTo || null, updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentBatchStagingItems.tenantId, ctx.tenantId), eq(paymentBatchStagingItems.id, staging.id), eq(paymentBatchStagingItems.status, "staged"))).returning().then((values) => values[0]);
        if (!updated) throw new DomainError("PAYMENT_BATCH_STAGING_REVIEW_CONFLICT", "Staging item was reviewed concurrently", 409);
        await tx.update(paymentBatchPreviews).set({ status: "stale" }).where(and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), eq(paymentBatchPreviews.batchId, batch.id), inArray(paymentBatchPreviews.status, ["ready", "needs_review"])));
        await tx.update(paymentBatches).set({ status: "needs_review", version: batch.version + 1, stateHash: digest({ batchPublicId: batch.publicId, revision: staging.revision + 1 }), confirmationHash: null, updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, batch.id)));
        const result = { stagingItemPublicId: staging.publicId, status: updated.status, paymentIntakePublicId: intake.publicId, batchItemPublicId: batchItem.publicId, receipt: { operationType: "staging.review", operationKey: input.intakeIdempotencyKey.trim() } };
        return recordOperation(tx, ctx, batch, staging.id, "staging.review", input.intakeIdempotencyKey.trim(), requestHash, result);
    });
}

export type EditPaymentBatchStagingItemInput = {
    stagingItemPublicId: string;
    expectedRevision: number;
    idempotencyKey: string;
    reason: string;
    amount?: string;
    receivedAt?: string;
    mapping?: { borrowerPublicId?: string; loanPublicId?: string; schedulePublicId?: string } | null;
};

export async function editPaymentBatchStagingItem(ctx: CommandContext, input: EditPaymentBatchStagingItemInput) {
    requireId(input.stagingItemPublicId, "stagingItemPublicId");
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1 || !input.idempotencyKey.trim() || !input.reason.trim()) throw new DomainError("INVALID_STAGING_EDIT", "A staging edit needs a revision, idempotency key and reason", 400);
    const amount = input.amount === undefined ? undefined : serializeMoney(parseMoney(input.amount));
    const receivedAt = input.receivedAt === undefined ? undefined : new Date(input.receivedAt);
    if (receivedAt && Number.isNaN(receivedAt.getTime())) throw new DomainError("INVALID_RECEIVED_AT", "receivedAt must be an ISO date-time", 400);
    if (amount !== undefined && parseMoney(amount).lte(0)) throw new DomainError("INVALID_PAYMENT_AMOUNT", "Payment amount must be positive", 400);
    for (const [field, value] of Object.entries(input.mapping ?? {})) if (value) requireId(value, field);
    const requestHash = digest({ stagingItemPublicId: input.stagingItemPublicId, expectedRevision: input.expectedRevision, amount: amount === undefined ? { omitted: true } : amount, receivedAt: receivedAt === undefined ? { omitted: true } : receivedAt.toISOString(), mapping: input.mapping === undefined ? { omitted: true } : { value: input.mapping }, reason: input.reason.trim() });
    return db.transaction(async (tx) => {
        const preliminary = await accessibleStagingItem(ctx, input.stagingItemPublicId, tx);
        const borrowerIds = [preliminary.batch.borrowerId].filter((id): id is number => id !== null);
        if (preliminary.staging.paymentIntakeId) borrowerIds.push(...await paymentIntakeBorrowerIds(tx, ctx.tenantId, preliminary.staging.paymentIntakeId));
        const currentMapping = preliminary.staging.reviewedMapping;
        const mappingsToLock = [currentMapping, input.mapping === undefined ? currentMapping : input.mapping].filter((mapping): mapping is NonNullable<typeof mapping> => mapping !== null && mapping !== undefined);
        for (const mapping of mappingsToLock) {
            const mappingLoan = mapping.loanPublicId ? await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, mapping.loanPublicId)) }) : null;
            const mappingBorrower = mapping.borrowerPublicId ? await tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, mapping.borrowerPublicId)) }) : mappingLoan ? await tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.id, mappingLoan.borrowerId)) }) : null;
            if (mappingBorrower) borrowerIds.push(mappingBorrower.id);
        }
        await lockPaymentBorrowers(tx, ctx.tenantId, borrowerIds);
        const { staging, batch } = await lockedStagingItem(ctx, input.stagingItemPublicId, tx);
        const prior = await operationReceipt<{ stagingItemPublicId: string; status: string; revision: number }>(tx, ctx, "staging.edit", input.idempotencyKey.trim(), requestHash);
        if (prior) return prior;
        if (staging.revision !== preliminary.staging.revision || digest(staging.reviewedMapping) !== digest(preliminary.staging.reviewedMapping) || batch.version !== preliminary.batch.version) throw new DomainError("STAGING_MAPPING_STALE", "Staging mapping changed while edit was waiting for its locks; inspect and retry", 409);
        assertBatchEditable(batch);
        if (staging.revision !== input.expectedRevision) throw new DomainError("STAGING_REVISION_STALE", "Staging item revision is stale", 409);
        if (staging.status === "failed") throw new DomainError("PAYMENT_BATCH_STAGING_EDIT_CONFLICT", "Failed staging items cannot be edited", 409);
        let mappedBorrowerId: number | null = null;
        if (input.mapping?.borrowerPublicId) {
            const mappedBorrower = await tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, input.mapping.borrowerPublicId)) });
            if (!mappedBorrower) throw new DomainError("BORROWER_NOT_FOUND", "Mapped borrower is unavailable", 404);
            await assertBorrowerPortfolio(ctx, [mappedBorrower], tx);
            mappedBorrowerId = mappedBorrower.id;
        }
        if (input.mapping?.loanPublicId) {
            const mappedLoan = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, input.mapping.loanPublicId)) });
            if (!mappedLoan) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Mapped loan is unavailable", 409);
            if (mappedBorrowerId === null) {
                const mappedBorrower = await tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.id, mappedLoan.borrowerId)) });
                if (!mappedBorrower) throw new DomainError("BORROWER_NOT_FOUND", "Mapped borrower is unavailable", 404);
                await assertBorrowerPortfolio(ctx, [mappedBorrower], tx);
                mappedBorrowerId = mappedBorrower.id;
            }
            if (mappedLoan.borrowerId !== mappedBorrowerId) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Mapped loan does not belong to the mapped borrower", 409);
            if (input.mapping.schedulePublicId) {
                const mappedSchedule = await tx.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.publicId, input.mapping.schedulePublicId), eq(loanSchedules.loanId, mappedLoan.id)) });
                if (!mappedSchedule) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Mapped schedule does not belong to the mapped loan", 409);
            }
        } else if (input.mapping?.schedulePublicId) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "A schedule mapping requires a loan mapping", 409);
        const nextMapping = input.mapping === undefined ? staging.reviewedMapping : input.mapping;
        const nextResolutionState = input.mapping === undefined ? staging.resolutionState : input.mapping === null ? "cleared" : "mapped";
        const mappedLoan = nextMapping?.loanPublicId ? await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, nextMapping.loanPublicId)) }) : null;
        if (staging.paymentIntakeId) {
            const intake = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, staging.paymentIntakeId)) });
            if (!intake || ["posted", "cancelled", "reversed", "rejected"].includes(intake.status)) throw new DomainError("PAYMENT_BATCH_STAGING_EDIT_CONFLICT", "Posted or terminal payment intake cannot be edited", 409);
            if (amount !== undefined || receivedAt !== undefined || input.mapping !== undefined) await tx.update(paymentIntakes).set({ ...(amount !== undefined ? { amount } : {}), ...(receivedAt ? { receivedAt } : {}), ...(input.mapping !== undefined ? { originLoanId: mappedLoan?.id ?? null } : {}), updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(eq(paymentIntakes.id, intake.id));
        }
        const updated = await tx.update(paymentBatchStagingItems).set({ ...(amount !== undefined ? { amount } : {}), ...(receivedAt ? { receivedAt } : {}), reviewedMapping: nextMapping, resolutionState: nextResolutionState, revision: staging.revision + 1, updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentBatchStagingItems.tenantId, ctx.tenantId), eq(paymentBatchStagingItems.id, staging.id), eq(paymentBatchStagingItems.revision, input.expectedRevision))).returning().then((rows) => rows[0]);
        if (!updated) throw new DomainError("STAGING_REVISION_STALE", "Staging item revision is stale", 409);
        await tx.update(paymentBatchPreviews).set({ status: "stale" }).where(and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), eq(paymentBatchPreviews.batchId, batch.id), inArray(paymentBatchPreviews.status, ["ready", "needs_review"])));
        if (staging.paymentIntakeId) await tx.update(paymentMatchProposals).set({ status: "stale", updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentMatchProposals.tenantId, ctx.tenantId), eq(paymentMatchProposals.paymentIntakeId, staging.paymentIntakeId), inArray(paymentMatchProposals.status, ["draft", "ready", "needs_review"])));
        await tx.update(paymentBatches).set({ status: "needs_review", version: batch.version + 1, confirmationHash: null, stateHash: digest({ batchPublicId: batch.publicId, revision: updated.revision }), updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(eq(paymentBatches.id, batch.id));
        return recordOperation(tx, ctx, batch, staging.id, "staging.edit", input.idempotencyKey.trim(), requestHash, { stagingItemPublicId: updated.publicId, status: updated.status, revision: updated.revision });
    });
}

export type SplitPaymentBatchInput = { selectedItemPublicIds: string[]; expectedSourceRevision: number; idempotencyKey: string; reason: string };
export async function splitPaymentBatch(ctx: CommandContext, sourceBatchPublicId: string, input: SplitPaymentBatchInput) {
    requireId(sourceBatchPublicId, "sourceBatchPublicId");
    if (!input.selectedItemPublicIds.length || input.selectedItemPublicIds.length > 50 || new Set(input.selectedItemPublicIds).size !== input.selectedItemPublicIds.length || !input.idempotencyKey.trim() || !input.reason.trim()) throw new DomainError("INVALID_BATCH_SPLIT", "A split needs unique selected items, idempotency key and reason", 400);
    input.selectedItemPublicIds.forEach((id) => requireId(id, "selectedItemPublicId"));
    const requestHash = digest({ sourceBatchPublicId, selectedItemPublicIds: [...input.selectedItemPublicIds].sort(), expectedSourceRevision: input.expectedSourceRevision, reason: input.reason.trim() });
    return db.transaction(async (tx) => {
        await accessibleBatch(ctx, sourceBatchPublicId, tx);
        const sourceId = (await accessibleBatch(ctx, sourceBatchPublicId, tx)).id;
        await tx.execute(sql`SELECT id FROM payment_batches WHERE tenant_id = ${ctx.tenantId} AND id = ${sourceId} FOR UPDATE`);
        const lockedSource = await accessibleBatch(ctx, sourceBatchPublicId, tx);
        const prior = await operationReceipt<{ sourceBatchPublicId: string; destinationBatchPublicId: string; dependencyPublicId: string; movedItemPublicIds: string[] }>(tx, ctx, "batch.split", input.idempotencyKey.trim(), requestHash);
        if (prior) return prior;
        assertBatchEditable(lockedSource);
        if (lockedSource.version !== input.expectedSourceRevision) throw new DomainError("BATCH_REVISION_STALE", "Source batch revision is stale", 409);
        const currentSource = lockedSource;
        const sourceItems = await tx.select().from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, currentSource.id)));
        const sourceStaging = await tx.select().from(paymentBatchStagingItems).where(and(eq(paymentBatchStagingItems.tenantId, ctx.tenantId), eq(paymentBatchStagingItems.batchId, currentSource.id)));
        const selectedItems: typeof sourceItems = [];
        const selectedStaging: typeof sourceStaging = [];
        const seenMemberships = new Set<string>();
        for (const publicId of input.selectedItemPublicIds) {
            const item = sourceItems.find((candidate) => candidate.publicId === publicId);
            const staging = sourceStaging.find((candidate) => candidate.publicId === publicId);
            if (item && staging) throw new DomainError("BATCH_SPLIT_AMBIGUOUS_SELECTION", "A selection cannot identify both sides of one membership", 409);
            const linkedItem = item ?? (staging?.batchItemId ? sourceItems.find((candidate) => candidate.id === staging.batchItemId) : undefined);
            const linkedStaging = staging ?? (item ? sourceStaging.find((candidate) => candidate.batchItemId === item.id) : undefined);
            if (!linkedItem && !linkedStaging) throw new DomainError("BATCH_SPLIT_SELECTION_INVALID", "Every selected item must belong to the source batch", 409);
            const membershipKey = linkedItem ? `item:${linkedItem.id}` : `staging:${linkedStaging!.id}`;
            if (seenMemberships.has(membershipKey)) throw new DomainError("BATCH_SPLIT_AMBIGUOUS_SELECTION", "The same batch membership was selected more than once", 409);
            seenMemberships.add(membershipKey);
            if (linkedItem) selectedItems.push(linkedItem);
            if (linkedStaging) selectedStaging.push(linkedStaging);
        }
        const selectedIntakeIds = selectedItems.map((item) => item.paymentIntakeId);
        const reviewedStaging = selectedStaging.filter((item) => item.paymentIntakeId !== null);
        for (const staged of reviewedStaging) if (!selectedItems.some((item) => item.id === staged.batchItemId)) throw new DomainError("BATCH_SPLIT_SELECTION_INVALID", "Reviewed staging membership is inconsistent", 409);
        const intakes = await tx.select().from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, selectedIntakeIds)));
        if (intakes.some((intake) => ["posted", "reversed", "cancelled"].includes(intake.status))) throw new DomainError("BATCH_SPLIT_POSTED_MEMBER", "Posted or terminal batch members cannot be split", 409);
        const [destination] = await tx.insert(paymentBatches).values({ tenantId: ctx.tenantId, borrowerId: currentSource.borrowerId, status: "draft", version: 1, stateHash: digest({ sourceBatchPublicId, selected: input.selectedItemPublicIds }), createIdempotencyKey: `split:${currentSource.publicId}:${input.idempotencyKey.trim()}`, notes: `Split from ${currentSource.publicId}`, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning();
        if (!destination) throw new Error("Destination batch insert did not return a row");
        const ordered = [...selectedItems].sort((a, b) => a.itemOrder - b.itemOrder);
        for (const [index, item] of ordered.entries()) await tx.update(paymentBatchItems).set({ batchId: destination.id, itemOrder: index + 1 }).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.id, item.id)));
        for (const item of selectedStaging) await tx.update(paymentBatchStagingItems).set({ batchId: destination.id, updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(eq(paymentBatchStagingItems.id, item.id));
        await tx.update(paymentBatchPreviews).set({ status: "stale" }).where(and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), inArray(paymentBatchPreviews.batchId, [currentSource.id, destination.id]), inArray(paymentBatchPreviews.status, ["ready", "needs_review"])));
        const [dependency] = await tx.insert(paymentBatchDependencies).values({ tenantId: ctx.tenantId, sourceBatchId: currentSource.id, destinationBatchId: destination.id, relation: "split", sourceRevision: currentSource.version + 1, destinationRevision: 1, reason: input.reason.trim(), provenance: { sourceBatchPublicId: currentSource.publicId, selectedItemPublicIds: [...input.selectedItemPublicIds].sort() }, createdByUserId: ctx.actorUserId }).returning();
        await tx.update(paymentBatches).set({ version: currentSource.version + 1, status: "needs_review", confirmationHash: null, stateHash: digest({ batchPublicId: currentSource.publicId, remainingItemCount: sourceItems.length - selectedItems.length + sourceStaging.length - selectedStaging.length }), updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(eq(paymentBatches.id, currentSource.id));
        await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_batch", entityId: currentSource.publicId, action: "split", payload: { destinationBatchPublicId: destination.publicId, movedItemPublicIds: input.selectedItemPublicIds } });
        return recordOperation(tx, ctx, currentSource, null, "batch.split", input.idempotencyKey.trim(), requestHash, { sourceBatchPublicId: currentSource.publicId, destinationBatchPublicId: destination.publicId, dependencyPublicId: dependency!.publicId, movedItemPublicIds: [...input.selectedItemPublicIds].sort() });
    });
}

export async function capturePaymentBatch(ctx: CommandContext, input: {
    idempotencyKey: string;
    borrowerPublicId?: string | null;
    notes?: string | null;
    items: CapturePaymentBatchItemInput[];
}) {
    await actor(ctx);
    const batchKey = input.idempotencyKey.trim();
    if (!batchKey) throw new DomainError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey must not be blank", 400);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) throw new DomainError("INVALID_BATCH_ITEMS", "Payment batch must contain 1 to 50 items", 400);
    const clientKeys = input.items.map((item) => item.clientItemKey.trim());
    if (clientKeys.some((key) => !key) || new Set(clientKeys).size !== clientKeys.length) throw new DomainError("DUPLICATE_BATCH_ITEM_KEY", "Batch item keys must be unique and non-blank", 400);
    const intakeKeys = input.items.map((item) => item.intakeIdempotencyKey.trim());
    if (intakeKeys.some((key) => !key) || new Set(intakeKeys).size !== intakeKeys.length) throw new DomainError("DUPLICATE_IDEMPOTENCY_KEY", "Payment intake idempotency keys must be unique and non-blank", 400);
    const parsed = input.items.map((item, index) => {
        let amount: Decimal;
        try { amount = parseMoney(item.amount); } catch { throw new DomainError("INVALID_PAYMENT_AMOUNT", "Payment amounts must be positive strings with exactly two decimals", 400); }
        if (amount.lte(0)) throw new DomainError("INVALID_PAYMENT_AMOUNT", "Payment amounts must be positive strings with exactly two decimals", 400);
        const receivedAt = new Date(item.receivedAt);
        if (Number.isNaN(receivedAt.getTime())) throw new DomainError("INVALID_RECEIVED_AT", "receivedAt must be an ISO date-time", 400);
        const reference = item.bankReference?.trim() || null;
        return { ...item, clientItemKey: clientKeys[index]!, intakeIdempotencyKey: intakeKeys[index]!, amount: serializeMoney(amount), receivedAt, reference, bankReferenceHash: reference ? digestBankReference(normalizeBankReference(reference)) : null };
    }).sort((a, b) => a.clientItemKey.localeCompare(b.clientItemKey));
    if (new Set(parsed.map((item) => item.bankReferenceHash).filter((value): value is string => value !== null)).size !== parsed.filter((item) => item.bankReferenceHash !== null).length) throw new DomainError("DUPLICATE_BANK_REFERENCE", "Bank reference appears more than once in this batch", 409);

    const requestHash = digest({ borrowerPublicId: input.borrowerPublicId ?? null, notes: input.notes ?? null, items: parsed });
    type CapturedResult = Omit<ReturnType<typeof presentBatch>, "items"> & { items: Array<{ clientItemKey: string; paymentIntakePublicId: string; batchItemPublicId: string; status: string; duplicate: boolean }> };
    const receipt = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:batch-create:${batchKey}`}, 0))`);
        const prior = await operationReceipt<CapturedResult>(tx, ctx, "batch.capture", batchKey, requestHash);
        if (prior) return prior;
        const existing = await tx.query.paymentBatches.findFirst({ where: and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.createIdempotencyKey, batchKey)) });
        if (existing) {
            await accessibleBatch(ctx, existing.publicId, tx);
            throw new DomainError("BATCH_CAPTURE_IDEMPOTENCY_CONFLICT", "The batch capture key belongs to an existing operation without a matching receipt", 409);
        }
        let borrowerId: number | null = null;
        if (input.borrowerPublicId) {
            requireId(input.borrowerPublicId, "borrowerPublicId");
            const borrower = await tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, input.borrowerPublicId)) });
            if (!borrower) throw new DomainError("BORROWER_NOT_FOUND", "Borrower not found", 404);
            await assertBorrowerPortfolio(ctx, [borrower], tx);
            borrowerId = borrower.id;
        }
        const allIntakes = await tx.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, ctx.tenantId));
        for (const item of parsed) {
            if (allIntakes.some((row) => row.idempotencyKey === item.intakeIdempotencyKey || (item.bankReferenceHash !== null && row.bankReferenceHash === item.bankReferenceHash))) {
                throw new DomainError("DUPLICATE_PAYMENT_INTAKE", "A payment intake with this idempotency key or bank reference already exists", 409);
            }
        }
        const batch = await tx.insert(paymentBatches).values({ tenantId: ctx.tenantId, borrowerId, status: borrowerId ? "draft" : "needs_review", version: parsed.length, stateHash: digest({ borrowerPublicId: input.borrowerPublicId ?? null, items: parsed.map((item) => ({ key: item.clientItemKey, amount: item.amount, receivedAt: item.receivedAt.toISOString() })) }), createIdempotencyKey: batchKey, notes: input.notes ?? null, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_batch", entityId: batch.publicId, action: "created", payload: { batchPublicId: batch.publicId, itemCount: parsed.length } });
        const rows: Array<{ clientItemKey: string; intakePublicId: string; itemPublicId: string }> = [];
        for (const [index, item] of parsed.entries()) {
            const staging = await tx.insert(paymentBatchStagingItems).values({
                tenantId: ctx.tenantId,
                batchId: batch.id,
                clientItemKey: item.clientItemKey,
                payloadFingerprint: digest({ clientItemKey: item.clientItemKey, amount: item.amount, receivedAt: item.receivedAt.toISOString(), payerName: item.payerName?.trim() || null, bankReferenceHash: item.bankReferenceHash, intakeIdempotencyKey: item.intakeIdempotencyKey }),
                amount: item.amount,
                receivedAt: item.receivedAt,
                payerName: item.payerName?.trim() || null,
                bankReferenceHash: item.bankReferenceHash,
                status: "staged",
                createdByUserId: ctx.actorUserId,
                updatedByUserId: ctx.actorUserId,
            }).returning().then((values) => values[0]!);
            const warnings = allIntakes.filter((candidate) => candidate.amount === item.amount && candidate.payerName && normalizeBorrowerText(candidate.payerName) === normalizeBorrowerText(item.payerName ?? "") && Math.abs(candidate.receivedAt.getTime() - item.receivedAt.getTime()) <= 5 * 60 * 1000).length ? [{ code: "POSSIBLE_SEMANTIC_DUPLICATE" }] : [];
            const intake = await tx.insert(paymentIntakes).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, source: ctx.actorSource === "mcp" ? "mcp" : "web", status: warnings.length ? "needs_review" : "draft", amount: item.amount, receivedAt: item.receivedAt, payerName: item.payerName?.trim() || null, bankReference: item.reference, bankReferenceHash: item.bankReferenceHash, warnings, idempotencyKey: item.intakeIdempotencyKey, notes: input.notes ?? null, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((values) => values[0]!);
            const batchItem = await tx.insert(paymentBatchItems).values({ tenantId: ctx.tenantId, batchId: batch.id, paymentIntakeId: intake.id, stagingItemId: staging.id, itemOrder: index + 1 }).returning().then((values) => values[0]!);
            await tx.update(paymentBatchStagingItems).set({ paymentIntakeId: intake.id, batchItemId: batchItem.id, status: "validated", updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentBatchStagingItems.tenantId, ctx.tenantId), eq(paymentBatchStagingItems.id, staging.id)));
            await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_intake", entityId: intake.publicId, action: "created", payload: { amount: item.amount, receivedAt: item.receivedAt.toISOString(), warningCodes: warnings.map((warning) => warning.code) } });
            rows.push({ clientItemKey: item.clientItemKey, intakePublicId: intake.publicId, itemPublicId: batchItem.publicId });
        }
        const batchView = await view(ctx, batch, tx);
        const result = { ...batchView, items: rows.map((item) => ({ clientItemKey: item.clientItemKey, paymentIntakePublicId: item.intakePublicId, batchItemPublicId: item.itemPublicId, status: "draft", duplicate: false })) };
        // JSON normalization makes first delivery identical to persisted replay.
        return recordOperation(tx, ctx, batch, null, "batch.capture", batchKey, requestHash, JSON.parse(JSON.stringify(result)) as CapturedResult);
    });
    const { auditPublicId: _auditPublicId, correlationId: _correlationId, ...result } = receipt;
    return result;
}

export async function addPaymentBatchItem(ctx: CommandContext, batchPublicId: string, input: { paymentIntakePublicId: string; itemOrder: number }) {
    const batch = await accessibleBatch(ctx, batchPublicId);
    if (!Number.isInteger(input.itemOrder) || input.itemOrder < 1) throw new DomainError("INVALID_ITEM_ORDER", "itemOrder must be positive", 400);
    requireId(input.paymentIntakePublicId, "paymentIntakePublicId");
    const intake = await db.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, input.paymentIntakePublicId)) });
    if (!intake) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    if (!["draft", "needs_review", "ready"].includes(intake.status)) throw new DomainError("PAYMENT_BATCH_ITEM_NOT_ELIGIBLE", "Payment intake is not eligible for a batch", 409);
    if (batch.status === "posted" || batch.status === "cancelled") throw new DomainError("PAYMENT_BATCH_NOT_EDITABLE", "Payment batch is not editable", 409);
    try {
        const row = await db.transaction(async (tx) => {
            const created = await tx.insert(paymentBatchItems).values({ tenantId: ctx.tenantId, batchId: batch.id, paymentIntakeId: intake.id, itemOrder: input.itemOrder }).returning().then((rows) => rows[0]!);
            await tx.update(paymentBatches).set({ version: batch.version + 1, status: "needs_review", stateHash: digest({ batch: batch.publicId, item: input.paymentIntakePublicId, amount: intake.amount }), updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, batch.id)));
            return created;
        });
        return view(ctx, { ...batch, version: batch.version + 1, status: "needs_review" }, db);
    } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new DomainError("PAYMENT_INTAKE_ALREADY_IN_BATCH", "Payment intake already belongs to a batch", 409);
        throw error;
    }
}

export async function getPaymentBatch(ctx: CommandContext, batchPublicId: string) { return view(ctx, await accessibleBatch(ctx, batchPublicId)); }

/**
 * Read-only resumable staging workspace. It intentionally exposes lifecycle
 * metadata and public links only; raw files, storage keys, hashes, and OCR
 * contents remain behind the evidence service.
 */
export async function getPaymentBatchWorkspace(ctx: CommandContext, batchPublicId: string) {
    const batch = await accessibleBatch(ctx, batchPublicId);
    const [summary, stagingItems, batchItems] = await Promise.all([
        view(ctx, batch),
        db.select().from(paymentBatchStagingItems).where(and(eq(paymentBatchStagingItems.tenantId, ctx.tenantId), eq(paymentBatchStagingItems.batchId, batch.id))).orderBy(asc(paymentBatchStagingItems.id)),
        db.select().from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, batch.id))),
    ]);
    const evidence = stagingItems.length
        ? await db.select({ stagingItemId: paymentBatchStagingEvidence.stagingItemId, publicId: paymentBatchStagingEvidence.publicId, status: paymentBatchStagingEvidence.status, mimeType: paymentBatchStagingEvidence.mimeType, declaredSize: paymentBatchStagingEvidence.declaredSize, finalizedAt: paymentBatchStagingEvidence.finalizedAt }).from(paymentBatchStagingEvidence).where(and(eq(paymentBatchStagingEvidence.tenantId, ctx.tenantId), inArray(paymentBatchStagingEvidence.stagingItemId, stagingItems.map((item) => item.id))))
        : [];
    return {
        batchPublicId: batch.publicId,
        batch: summary,
        items: stagingItems.map((item) => {
            const itemEvidence = evidence.find((entry) => entry.stagingItemId === item.id);
            const batchItem = batchItems.find((candidate) => candidate.id === item.batchItemId);
            const intakePublicId = batchItem ? summary.items.find((candidate) => candidate.publicId === batchItem.publicId)?.paymentIntakePublicId ?? null : null;
            return {
                publicId: item.publicId,
                clientItemKey: item.clientItemKey,
                status: item.status,
                revision: item.revision,
                amount: item.amount,
                receivedAt: item.receivedAt?.toISOString() ?? null,
                payerName: item.payerName,
                paymentIntakePublicId: intakePublicId,
                batchItemPublicId: batchItem?.publicId ?? null,
                reviewedReason: item.reviewedReason,
                reviewedRangeFrom: item.reviewedRangeFrom,
                reviewedRangeTo: item.reviewedRangeTo,
                evidence: itemEvidence ? { publicId: itemEvidence.publicId, status: itemEvidence.status, mimeType: itemEvidence.mimeType, declaredSize: itemEvidence.declaredSize, finalizedAt: itemEvidence.finalizedAt } : null,
                evidenceStatus: itemEvidence?.status ?? null,
            };
        }),
    };
}

type BatchEvidencePrepareItem = { batchItemPublicId: string; paymentIntakePublicId: string; mimeType: "image/jpeg" | "image/png" | "application/pdf"; size: number; sha256: string; evidenceType?: "slip" | "qr" };
type BatchEvidenceFinalizeItem = { batchItemPublicId: string; paymentIntakePublicId: string; evidencePublicId: string };
async function assertBatchEvidenceItems(ctx: CommandContext, batchPublicId: string, items: Array<{ batchItemPublicId: string; paymentIntakePublicId: string }>) {
    const batch = await accessibleBatch(ctx, batchPublicId);
    if (!items.length || items.length > 50) throw new DomainError("INVALID_BATCH_EVIDENCE_ITEMS", "Batch evidence requires 1 to 50 items", 400);
    if (new Set(items.map((item) => item.batchItemPublicId)).size !== items.length) throw new DomainError("DUPLICATE_BATCH_ITEM", "Each batch item may appear only once", 400);
    const rows = await db.select().from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, batch.id)));
    const intakeRows = await db.select().from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.publicId, items.map((item) => item.paymentIntakePublicId))));
    for (const item of items) {
        requireId(item.batchItemPublicId, "batchItemPublicId"); requireId(item.paymentIntakePublicId, "paymentIntakePublicId");
        const intake = intakeRows.find((row) => row.publicId === item.paymentIntakePublicId);
        if (!intake || !rows.some((row) => row.publicId === item.batchItemPublicId && row.paymentIntakeId === intake.id)) throw new DomainError("PAYMENT_BATCH_ITEM_MISMATCH", "Evidence item does not belong to the payment batch", 409);
    }
}
export async function preparePaymentBatchEvidenceMany(ctx: CommandContext, batchPublicId: string, items: BatchEvidencePrepareItem[], gateway?: EvidenceStorageGateway) {
    await assertBatchEvidenceItems(ctx, batchPublicId, items);
    const results = await Promise.all(items.map(async (item) => ({ batchItemPublicId: item.batchItemPublicId, paymentIntakePublicId: item.paymentIntakePublicId, ...(await preparePaymentEvidence(ctx, item.paymentIntakePublicId, item, gateway)) })));
    return { batchPublicId, items: results };
}
export async function finalizePaymentBatchEvidenceMany(ctx: CommandContext, batchPublicId: string, items: BatchEvidenceFinalizeItem[], gateway?: EvidenceStorageGateway) {
    await assertBatchEvidenceItems(ctx, batchPublicId, items);
    const results = await Promise.all(items.map(async (item) => ({ batchItemPublicId: item.batchItemPublicId, paymentIntakePublicId: item.paymentIntakePublicId, ...(await finalizePaymentEvidence(ctx, item.paymentIntakePublicId, item.evidencePublicId, gateway)) })));
    const batch = await accessibleBatch(ctx, batchPublicId);
    const members = await db.select().from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, batch.id)));
    const evidence = members.length ? await db.select().from(paymentEvidence).where(and(eq(paymentEvidence.tenantId, ctx.tenantId), inArray(paymentEvidence.paymentIntakeId, members.map((member) => member.paymentIntakeId)))) : [];
    return { batchPublicId, allEvidenceReady: members.every((member) => evidence.some((entry) => entry.paymentIntakeId === member.paymentIntakeId && entry.status === "ready")), items: results };
}
export async function cancelPaymentBatch(ctx: CommandContext, batchPublicId: string, input: { reason: string; revision: number; idempotencyKey: string } = { reason: "legacy cancellation", revision: -1, idempotencyKey: `legacy-cancel:${batchPublicId}` }) {
    const batch = await accessibleBatch(ctx, batchPublicId);
    const reason = input.reason.trim().replace(/[\u0000-\u001f\u007f]/g, " ");
    if (!reason || reason.length > 2000 || !input.idempotencyKey.trim() || !Number.isInteger(input.revision) || input.revision < -1) throw new DomainError("INVALID_BATCH_CANCEL", "Cancellation needs a reason, current revision and idempotency key", 400);
    const requestHash = digest({ batchPublicId, reason, revision: input.revision });
    const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM payment_batches WHERE tenant_id = ${ctx.tenantId} AND id = ${batch.id} FOR UPDATE`);
        const current = await tx.query.paymentBatches.findFirst({ where: and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, batch.id)) });
        if (!current) throw new DomainError("PAYMENT_BATCH_NOT_FOUND", "Payment batch not found", 404);
        const prior = await operationReceipt<{ batchPublicId: string; status: string; reason: string; revision: number; view: unknown }>(tx, ctx, "batch.cancel", input.idempotencyKey.trim(), requestHash);
        if (prior) return prior.view;
        if (["posted", "cancelled"].includes(current.status)) throw new DomainError("PAYMENT_BATCH_NOT_EDITABLE", "Posted or cancelled batches cannot be cancelled", 409);
        if (input.revision !== -1 && input.revision !== current.version) throw new DomainError("BATCH_REVISION_STALE", "Batch revision changed; inspect and retry cancellation", 409);
        await tx.update(paymentBatchPreviews).set({ status: "stale" }).where(and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), eq(paymentBatchPreviews.batchId, current.id), inArray(paymentBatchPreviews.status, ["ready", "needs_review"])));
        const cancelled = await tx.update(paymentBatches).set({ status: "cancelled", version: current.version + 1, confirmationHash: null, cancelIdempotencyKey: input.idempotencyKey.trim(), cancelRequestHash: requestHash, cancelReason: reason, cancelRevision: current.version, updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, current.id))).returning().then((rows) => rows[0]!);
        const result = await view(ctx, cancelled, tx);
        return recordOperation(tx, ctx, cancelled, null, "batch.cancel", input.idempotencyKey.trim(), requestHash, { batchPublicId: cancelled.publicId, status: cancelled.status, reason, revision: current.version, view: result });
    });
    return updated;
}

export type BatchDecisionInput = { previewPublicId: string; previewHash: string; revision: number; action: "confirm_no_older_pending"; reason: string; fromDate: string; toDate: string; idempotencyKey: string };
export async function decidePaymentBatch(ctx: CommandContext, batchPublicId: string, input: BatchDecisionInput) {
    const reason = input.reason.trim().replace(/[\u0000-\u001f\u007f]/g, " ");
    const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
    if (!reason || reason.length > 2000 || !input.idempotencyKey.trim() || input.action !== "confirm_no_older_pending" || !validDate(input.fromDate) || !validDate(input.toDate) || input.fromDate > input.toDate) throw new DomainError("INVALID_BATCH_DECISION", "A decision needs a reason, valid reviewed date range and idempotency key", 400);
    requireId(input.previewPublicId, "previewPublicId");
    const requestHash = digest({ batchPublicId, ...input, reason });
    return db.transaction(async (tx) => {
        const found = await accessibleBatch(ctx, batchPublicId, tx);
        const source = await tx.query.paymentBatchPreviews.findFirst({ where: and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), eq(paymentBatchPreviews.batchId, found.id), eq(paymentBatchPreviews.publicId, input.previewPublicId)) });
        const allocations = source ? await tx.select().from(paymentBatchAllocations).where(and(eq(paymentBatchAllocations.tenantId, ctx.tenantId), eq(paymentBatchAllocations.previewId, source.id))) : [];
        const borrowerIds = [...new Set(allocations.map((row) => row.borrowerId))];
        await lockPaymentBorrowers(tx, ctx.tenantId, borrowerIds);
        await tx.execute(sql`SELECT id FROM payment_batches WHERE tenant_id = ${ctx.tenantId} AND id = ${found.id} FOR UPDATE`);
        const prior = await operationReceipt<{ decisionPublicId: string; batchPublicId: string; revision: number; action: string }>(tx, ctx, "batch.decision", input.idempotencyKey, requestHash);
        if (prior) return prior;
        const batch = await accessibleBatch(ctx, batchPublicId, tx);
        assertBatchEditable(batch);
        if (!source || !["ready", "needs_review"].includes(source.status) || source.previewHash !== input.previewHash || source.version !== batch.version || input.revision !== batch.version || source.expiresAt.getTime() <= Date.now()) throw new DomainError("BATCH_CONFIRMATION_STALE", "Decision must refer to the current unexpired preview", 409);
        if (source.stateHash !== await batchSnapshot(tx, ctx.tenantId, batch.id, borrowerIds)) throw new DomainError("BATCH_CONFIRMATION_STALE", "Batch state changed before the decision", 409);
        const items = await tx.select().from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, batch.id)));
        const intakes = await tx.select().from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, items.map((item) => item.paymentIntakeId))));
        for (const intake of intakes) {
            const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(intake.receivedAt);
            if (date < input.fromDate || date > input.toDate) throw new DomainError("INVALID_BATCH_DECISION", "Reviewed range must cover every batch transfer date", 409);
            for (const borrowerId of borrowerIds) await assertNoOlderPendingPayment(tx, ctx.tenantId, borrowerId, intake.receivedAt, intakes.map((row) => row.id));
        }
        const revision = batch.version + 1;
        const [decision] = await tx.insert(paymentBatchDecisions).values({ tenantId: ctx.tenantId, batchId: batch.id, previewId: source.id, revision, action: input.action, reason, fromDate: input.fromDate, toDate: input.toDate, previewHash: input.previewHash, createdByUserId: ctx.actorUserId }).returning();
        await tx.update(paymentBatchPreviews).set({ status: "stale" }).where(and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), eq(paymentBatchPreviews.batchId, batch.id), inArray(paymentBatchPreviews.status, ["ready", "needs_review"])));
        await tx.update(paymentBatches).set({ version: revision, status: "needs_review", confirmationHash: null, updatedAt: new Date(), updatedByUserId: ctx.actorUserId }).where(eq(paymentBatches.id, batch.id));
        return recordOperation(tx, ctx, batch, null, "batch.decision", input.idempotencyKey, requestHash, { decisionPublicId: decision!.publicId, batchPublicId, revision, action: input.action });
    });
}
export type PreviewPaymentBatchInput = { borrowerPublicId: string; allocations?: Array<ExplicitBatchAllocation>; decisionPublicId?: string };
export async function previewPaymentBatch(ctx: CommandContext, batchPublicId: string, input: PreviewPaymentBatchInput) {
    return db.transaction(async (db) => {
    requireId(input.borrowerPublicId, "borrowerPublicId");
    const batchForResolution = await accessibleBatch(ctx, batchPublicId, db);
    const stagedForResolution = await db.select().from(paymentBatchStagingItems).where(and(eq(paymentBatchStagingItems.tenantId, ctx.tenantId), eq(paymentBatchStagingItems.batchId, batchForResolution.id)));
    const mappedLoanPublicIds = stagedForResolution.flatMap((item) => item.reviewedMapping?.loanPublicId ? [item.reviewedMapping.loanPublicId] : []);
    const mappedLoans = mappedLoanPublicIds.length ? await db.select().from(loans).where(and(eq(loans.tenantId, ctx.tenantId), inArray(loans.publicId, mappedLoanPublicIds))) : [];
    const mappedBorrowerIds = [...new Set(mappedLoans.map((loan) => loan.borrowerId))];
    const mappedBorrowers = mappedBorrowerIds.length ? await db.select().from(borrowers).where(and(eq(borrowers.tenantId, ctx.tenantId), inArray(borrowers.id, mappedBorrowerIds))) : [];
    const mappedBorrowerPublicIds = [...stagedForResolution.flatMap((item) => item.reviewedMapping?.borrowerPublicId ? [item.reviewedMapping.borrowerPublicId] : []), ...mappedBorrowers.map((row) => row.publicId)];
    const mappingSnapshot = digest(stagedForResolution.map((item) => ({ publicId: item.publicId, revision: item.revision, mapping: item.reviewedMapping, resolutionState: item.resolutionState })).sort((a, b) => a.publicId.localeCompare(b.publicId)));
    const borrower = await db.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, input.borrowerPublicId)) });
    if (!borrower) throw new DomainError("BORROWER_NOT_FOUND", "Borrower not found", 404);
    const requestedBorrowers = [...new Set([input.borrowerPublicId, ...mappedBorrowerPublicIds, ...(input.allocations ?? []).flatMap((allocation) => allocation.borrowerPublicId ? [allocation.borrowerPublicId] : [])])];
    requestedBorrowers.forEach((id) => requireId(id, "borrowerPublicId"));
    const targetBorrowers = await db.select().from(borrowers).where(and(eq(borrowers.tenantId, ctx.tenantId), inArray(borrowers.publicId, requestedBorrowers))).orderBy(asc(borrowers.id));
    if (targetBorrowers.length !== requestedBorrowers.length) throw new DomainError("BORROWER_NOT_FOUND", "A selected borrower is unavailable", 404);
    await assertBorrowerPortfolio(ctx, targetBorrowers, db);
    await lockPaymentBorrowers(db, ctx.tenantId, targetBorrowers.map((row) => row.id));
    await accessibleBatch(ctx, batchPublicId, db);
    await db.execute(sql`SELECT id FROM payment_batches WHERE tenant_id = ${ctx.tenantId} AND public_id = ${batchPublicId} FOR UPDATE`);
    const batch = await accessibleBatch(ctx, batchPublicId, db);
    assertBatchEditable(batch);
    const lockedMappings = await db.select({ publicId: paymentBatchStagingItems.publicId, revision: paymentBatchStagingItems.revision, reviewedMapping: paymentBatchStagingItems.reviewedMapping, resolutionState: paymentBatchStagingItems.resolutionState }).from(paymentBatchStagingItems).where(and(eq(paymentBatchStagingItems.tenantId, ctx.tenantId), eq(paymentBatchStagingItems.batchId, batch.id)));
    if (digest(lockedMappings.map((item) => ({ publicId: item.publicId, revision: item.revision, mapping: item.reviewedMapping, resolutionState: item.resolutionState })).sort((a, b) => a.publicId.localeCompare(b.publicId))) !== mappingSnapshot) throw new DomainError("BATCH_MAPPING_STALE", "Staging mappings changed while preview was waiting for borrower locks; inspect and retry", 409);
    const decision = input.decisionPublicId ? await db.query.paymentBatchDecisions.findFirst({ where: and(eq(paymentBatchDecisions.tenantId, ctx.tenantId), eq(paymentBatchDecisions.batchId, batch.id), eq(paymentBatchDecisions.publicId, input.decisionPublicId), eq(paymentBatchDecisions.revision, batch.version)) }) : undefined;
    if (input.decisionPublicId && !decision) throw new DomainError("BATCH_DECISION_STALE", "Decision belongs to a different batch revision", 409);
    const items = await db.select().from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, batch.id))).orderBy(asc(paymentBatchItems.itemOrder));
    if (!items.length) throw new DomainError("BATCH_ITEMS_REQUIRED", "Payment batch must contain at least one item", 409);
    await assertBatchStagingComplete(ctx, batch, db);
    const intakes = await db.select().from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, items.map((item) => item.paymentIntakeId))));
    const evidence = await db.select().from(paymentEvidence).where(and(eq(paymentEvidence.tenantId, ctx.tenantId), inArray(paymentEvidence.paymentIntakeId, items.map((item) => item.paymentIntakeId))));
    const evidenceReady = intakes.every((intake) => !intake.evidenceRequired || evidence.some((entry) => entry.paymentIntakeId === intake.id && entry.status === "ready" && entry.finalizedAt !== null));
    if (!evidenceReady) throw new DomainError("EVIDENCE_REQUIRED_NOT_READY", "Required payment evidence is not ready", 409);
    const loansForBorrower = await db.select().from(loans).where(and(eq(loans.tenantId, ctx.tenantId), inArray(loans.borrowerId, targetBorrowers.map((row) => row.id)), eq(loans.status, "active")));
    const schedules = loansForBorrower.length ? await db.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, ctx.tenantId), inArray(loanSchedules.loanId, loansForBorrower.map((loan) => loan.id)))) : [];
    const obligations: BatchObligation[] = schedules.filter((schedule) => schedule.status !== "paid" && schedule.remainingDue !== "0").map((schedule) => {
        const loan = loansForBorrower.find((candidate) => candidate.id === schedule.loanId)!;
        return { borrowerPublicId: targetBorrowers.find((row) => row.id === loan.borrowerId)!.publicId, loanPublicId: loan.publicId, schedulePublicId: schedule.publicId, dueDate: schedule.dueDate, remainingDue: schedule.remainingDue, principalDue: schedule.scheduledPrincipal, interestDue: schedule.scheduledInterest, feeDue: schedule.scheduledFee, penaltyDue: "0.00" };
    });
    const slips: BatchSlip[] = items.map((item) => { const intake = intakes.find((candidate) => candidate.id === item.paymentIntakeId)!; return { itemPublicId: item.publicId, amount: intake.amount, receivedAt: intake.receivedAt.toISOString() }; });
    const stagingForItems = await db.select().from(paymentBatchStagingItems).where(and(eq(paymentBatchStagingItems.tenantId, ctx.tenantId), inArray(paymentBatchStagingItems.batchItemId, items.map((item) => item.id))));
    const authoritativeBorrowerByItem = new Map<string, string>();
    for (const item of items) {
        const mapping = stagingForItems.find((staging) => staging.batchItemId === item.id)?.reviewedMapping;
        if (mapping?.borrowerPublicId) {
            const selected = targetBorrowers.find((candidate) => candidate.publicId === mapping.borrowerPublicId);
            if (!selected) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Reviewed borrower is not accessible for this batch", 409);
            authoritativeBorrowerByItem.set(item.publicId, selected.publicId);
            const mappedLoan = mapping.loanPublicId ? loansForBorrower.find((candidate) => candidate.publicId === mapping.loanPublicId) : null;
            if (mappedLoan && targetBorrowers.find((candidate) => candidate.id === mappedLoan.borrowerId)?.publicId !== selected.publicId) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Reviewed loan does not belong to the reviewed borrower", 409);
        } else if (mapping?.loanPublicId) {
            const mappedLoan = loansForBorrower.find((candidate) => candidate.publicId === mapping.loanPublicId);
            if (!mappedLoan) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Mapped loan is not an eligible loan for this batch", 409);
            authoritativeBorrowerByItem.set(item.publicId, targetBorrowers.find((candidate) => candidate.id === mappedLoan.borrowerId)!.publicId);
        }
    }
    for (const slip of slips) slip.borrowerPublicId = authoritativeBorrowerByItem.get(slip.itemPublicId);
    const mappedAllocations = items.map((item) => {
        const mapping = stagingForItems.find((staging) => staging.batchItemId === item.id)?.reviewedMapping;
        if (!mapping?.loanPublicId) return null;
        const loan = loansForBorrower.find((candidate) => candidate.publicId === mapping.loanPublicId);
        if (!loan) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Mapped loan is not an eligible loan for this batch", 409);
        const schedule = mapping.schedulePublicId ? schedules.find((candidate) => candidate.publicId === mapping.schedulePublicId && candidate.loanId === loan.id) : undefined;
        if (mapping.schedulePublicId && !schedule) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Mapped schedule is not an eligible schedule for this loan", 409);
        return { itemPublicId: item.publicId, borrowerPublicId: targetBorrowers.find((candidate) => candidate.id === loan.borrowerId)!.publicId, loanPublicId: loan.publicId, ...(schedule ? { schedulePublicId: schedule.publicId } : {}), amount: intakes.find((intake) => intake.id === item.paymentIntakeId)!.amount, targetDueDate: schedule?.dueDate ?? bangkokBusinessDate(new Date(slips.find((slip) => slip.itemPublicId === item.publicId)!.receivedAt)), intent: "on_time" as const };
    });
    const hasReviewedMapping = mappedAllocations.some((allocation) => allocation !== null) || authoritativeBorrowerByItem.size > 0;
    if (!input.allocations && hasReviewedMapping && mappedAllocations.some((allocation) => allocation === null)) throw new DomainError("BATCH_MAPPING_REQUIRES_REVIEW", "Every item with a reviewed mapping must have a complete mapping before preview", 409);
    if (input.allocations && hasReviewedMapping) {
        for (const [index, mapped] of mappedAllocations.entries()) {
            if (!mapped) continue;
            const explicit = input.allocations.filter((allocation) => allocation.itemPublicId === mapped.itemPublicId);
            if (!explicit.length || explicit.some((allocation) => allocation.loanPublicId !== mapped.loanPublicId || allocation.schedulePublicId !== mapped.schedulePublicId || (allocation.borrowerPublicId ?? mapped.borrowerPublicId) !== mapped.borrowerPublicId)) throw new DomainError("BATCH_MAPPING_CONFLICT", `Explicit allocation conflicts with reviewed mapping for item ${index + 1}`, 409);
        }
        for (const [itemPublicId, borrowerPublicId] of authoritativeBorrowerByItem) {
            const explicit = input.allocations.filter((allocation) => allocation.itemPublicId === itemPublicId);
            if (!explicit.length || explicit.some((allocation) => allocation.borrowerPublicId && allocation.borrowerPublicId !== borrowerPublicId || loansForBorrower.find((loan) => loan.publicId === allocation.loanPublicId)?.borrowerId !== targetBorrowers.find((borrower) => borrower.publicId === borrowerPublicId)?.id)) throw new DomainError("BATCH_MAPPING_CONFLICT", "Explicit allocation conflicts with reviewed borrower mapping", 409);
        }
    }
    const effectiveAllocations = input.allocations ?? (mappedAllocations.every((allocation) => allocation !== null) ? mappedAllocations as ExplicitBatchAllocation[] : undefined);
    const planningSlips = [...slips].sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt) || left.itemPublicId.localeCompare(right.itemPublicId));
    const solved = effectiveAllocations ? { status: "ready" as const, allocations: effectiveAllocations.map((allocation) => ({ ...allocation, matchSource: "human_explicit" as const })), candidates: [], warnings: [] } : solvePaymentBatch({ obligations, slips: planningSlips });
    const chronologyResults = await Promise.all(targetBorrowers.map(async (target) => {
        const targetItems = items.filter((item) => {
            const solvedForItem = solved.allocations.filter((allocation) => allocation.itemPublicId === item.publicId);
            if (solvedForItem.length) return solvedForItem.some((allocation) => loansForBorrower.some((loan) => loan.publicId === allocation.loanPublicId && loan.borrowerId === target.id));
            const reviewedBorrower = authoritativeBorrowerByItem.get(item.publicId);
            return reviewedBorrower ? reviewedBorrower === target.publicId : input.borrowerPublicId === target.publicId;
        });
        if (!targetItems.length) return null;
        return inspectBatchChronology(ctx, batch, target.publicId, targetItems, intakes.filter((intake) => targetItems.some((item) => item.paymentIntakeId === intake.id)), evidence, db);
    }));
    const conflict = chronologyResults.find((result) => result?.status === "chronology_conflict");
    if (conflict) throw new DomainError("PAYMENT_CHRONOLOGY_CONFLICT", "Payment chronology requires review before preview", 409, { blockers: conflict.blockers, decisions: conflict.decisions });
    slips.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt) || a.itemPublicId.localeCompare(b.itemPublicId));
    solved.allocations.sort((a, b) => slips.findIndex((slip) => slip.itemPublicId === a.itemPublicId) - slips.findIndex((slip) => slip.itemPublicId === b.itemPublicId));
    solved.warnings.push(...chronologyResults.flatMap((result) => result?.warnings ?? []).filter((warning) => !decision || decision.fromDate > warning.fromDate || decision.toDate < warning.toDate).map((warning) => ({ code: warning.code, message: `${warning.fromDate} to ${warning.toDate}` })));
    const amountByItem = new Map(slips.map((slip) => [slip.itemPublicId, slip.amount]));
    const floatingPlans = new Map<string, Awaited<ReturnType<typeof projectFloatingBatchPayment>>>();
    const floatingStates = new Map<number, FloatingBatchState>();
    const componentsByAllocation = new Map<ExplicitBatchAllocation, Record<string, string>>();
    const projectedSchedules = new Map(schedules.map((row) => [row.publicId, row]));
    for (const allocation of solved.allocations) {
        const loan = loansForBorrower.find((candidate) => candidate.publicId === allocation.loanPublicId);
        if (!loan) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Allocation target is not an eligible active loan", 409);
        if (allocation.borrowerPublicId && allocation.borrowerPublicId !== targetBorrowers.find((row) => row.id === loan.borrowerId)?.publicId) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Selected loan does not belong to the selected borrower", 409);
        if (loan.repaymentType === "floating") {
            if (allocation.schedulePublicId) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Floating allocation cannot target a schedule", 409);
            const slip = slips.find((candidate) => candidate.itemPublicId === allocation.itemPublicId);
            if (!slip) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Allocation item is not in this batch", 409);
            const state = floatingStates.get(loan.id) ?? emptyFloatingBatchState();
            floatingStates.set(loan.id, state);
            const plan = await projectFloatingBatchPayment(db, ctx, loan, new Date(slip.receivedAt), allocation.amount, allocation.intent, state);
            floatingPlans.set(`${allocation.itemPublicId}:${allocation.loanPublicId}:${allocation.amount}`, plan);
            componentsByAllocation.set(allocation, plan.components);
            allocation.targetDueDate = plan.throughDate;
        } else if (!allocation.schedulePublicId || !obligations.some((obligation) => obligation.schedulePublicId === allocation.schedulePublicId && obligation.loanPublicId === allocation.loanPublicId)) {
            throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Allocation target is not an eligible active scheduled loan", 409);
        } else {
            const slip = slips.find((candidate) => candidate.itemPublicId === allocation.itemPublicId);
            if (!slip) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Allocation item is not in this batch", 409);
            const plan = await planScheduledPayment(db, ctx.tenantId, loan, projectedSchedules.get(allocation.schedulePublicId)!, allocation.amount, new Date(slip.receivedAt));
            if (plan.hasRestructure && solved.allocations.filter((row) => row.loanPublicId === loan.publicId).length > 1) throw new DomainError("BATCH_PROJECTED_STATE_UNSUPPORTED", "Multiple restructured allocations require a complete carried-balance projection", 409);
            componentsByAllocation.set(allocation, Object.fromEntries(Object.entries(plan.components).map(([key, value]) => [key, value.toFixed(2)])));
            projectedSchedules.set(allocation.schedulePublicId, plan.nextSchedule);
        }
    }
    const allocatedByItem = new Map<string, Decimal>();
    for (const allocation of solved.allocations) allocatedByItem.set(allocation.itemPublicId, (allocatedByItem.get(allocation.itemPublicId) ?? new Decimal(0)).plus(allocation.amount));
    if (input.allocations && (allocatedByItem.size !== slips.length || slips.some((slip) => allocatedByItem.get(slip.itemPublicId)?.toFixed(2) !== amountByItem.get(slip.itemPublicId)))) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Every payment intake must be allocated exactly", 409);
    const semantic = solved.allocations.map(({ itemPublicId, loanPublicId, schedulePublicId, amount, targetDueDate, intent }) => ({ itemPublicId, loanPublicId, schedulePublicId, amount, targetDueDate, intent }));
    const stateHash = await batchSnapshot(db, ctx.tenantId, batch.id, targetBorrowers.map((row) => row.id));
    const confirmationHash = `v1:${digest({ batchPublicId: batch.publicId, items: slips, allocations: semantic, decision: decision ? { publicId: decision.publicId, reason: decision.reason, fromDate: decision.fromDate, toDate: decision.toDate } : null, components: [...componentsByAllocation.values()], floatingPlans: [...floatingPlans.entries()], warnings: solved.warnings.map((warning) => warning.code) })}`;
    const previewHash = `v1:${digest({ stateHash, confirmationHash, candidates: solved.candidates })}`;
    const nextVersion = batch.version + 1;
    // Calendar gaps are evidence warnings, never implicit approval. A warning
    // must be resolved by a new preview-bound decision before execute can see
    // `ready`; no consumer may post a warning-bearing preview.
    const status = solved.status === "ready" && evidenceReady && solved.warnings.length === 0 ? "ready" : "needs_review";
    const created = await (async () => {
        const tx = db;
        await tx.update(paymentBatchPreviews).set({ status: "stale" }).where(and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), eq(paymentBatchPreviews.batchId, batch.id), eq(paymentBatchPreviews.status, "ready")));
        const allocationValues = solved.allocations.map((allocation, index) => {
            const loan = loansForBorrower.find((candidate) => candidate.publicId === allocation.loanPublicId)!;
            const schedule = allocation.schedulePublicId ? schedules.find((candidate) => candidate.publicId === allocation.schedulePublicId) : null;
            const item = items.find((candidate) => candidate.publicId === allocation.itemPublicId)!;
            return { tenantId: ctx.tenantId, itemId: item.id, allocationOrder: index + 1, borrowerId: loan.borrowerId, loanId: loan.id, scheduleId: schedule?.id ?? null, amount: allocation.amount, targetDueDate: allocation.targetDueDate, intent: allocation.intent, targetKind: loan.repaymentType === "floating" ? "floating" : "scheduled", floatingPlan: floatingPlans.get(`${allocation.itemPublicId}:${allocation.loanPublicId}:${allocation.amount}`) ?? null, calculatedComponents: componentsByAllocation.get(allocation)! };
        });
        const postingSequence = slips.map((slip) => slip.itemPublicId);
        const preview = await tx.insert(paymentBatchPreviews).values({ tenantId: ctx.tenantId, batchId: batch.id, version: nextVersion, status, stateHash, previewHash, confirmationHash, allocationSnapshotHash: allocationSnapshotHash(allocationValues, postingSequence), postingSequence, warnings: solved.warnings, candidates: solved.candidates, evidenceReady, expiresAt: new Date(Date.now() + 15 * 60 * 1000), createdByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        if (allocationValues.length) await tx.insert(paymentBatchAllocations).values(allocationValues.map((row) => ({ ...row, previewId: preview.id })));
        await tx.update(paymentBatches).set({ borrowerId: borrower.id, status, version: nextVersion, stateHash, confirmationHash: status === "ready" ? confirmationHash : null, updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, batch.id)));
        return preview;
    })();
    return { id: created.publicId, publicId: created.publicId, batchPublicId: batch.publicId, version: created.version, status, stateHash, previewHash, confirmationHash, evidenceReady, allocations: solved.allocations, candidates: solved.candidates, warnings: solved.warnings };
    });
}
export type PaymentBatchExecutionOptions = { afterStage?: (stage: "locks" | "preview" | "item" | "all") => Promise<void> | void };

export async function executePaymentBatch(ctx: CommandContext, batchPublicId: string, input: { previewPublicId: string; previewHash: string; confirmationHash: string; confirmed: true; idempotencyKey: string }, options: PaymentBatchExecutionOptions = {}) {
    const batch = await accessibleBatch(ctx, batchPublicId);
    if (!input.confirmed) throw new DomainError("BATCH_CONFIRMATION_REQUIRED", "Batch execution requires explicit confirmation", 409);
    if (!input.idempotencyKey.trim()) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Execution needs an idempotency key", 400);
    const requestHash = digest({ batchPublicId, ...input });
    requireId(input.previewPublicId, "previewPublicId");
    const run = async (tx: DbExecutor) => {
        const selected = await tx.query.paymentBatchPreviews.findFirst({ where: and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), eq(paymentBatchPreviews.batchId, batch.id), eq(paymentBatchPreviews.publicId, input.previewPublicId)) });
        const selectedAllocations = selected ? await tx.select().from(paymentBatchAllocations).where(and(eq(paymentBatchAllocations.tenantId, ctx.tenantId), eq(paymentBatchAllocations.previewId, selected.id))) : [];
        const initialBorrowerIds = [...new Set([...(batch.borrowerId === null ? [] : [batch.borrowerId]), ...selectedAllocations.map((row) => row.borrowerId)])].sort((a, b) => a - b);
        if (initialBorrowerIds.length) await tx.execute(sql`SELECT id FROM borrowers WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(initialBorrowerIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        let locked = await tx.query.paymentBatches.findFirst({ where: and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, batch.id)) });
        if (!locked) throw new DomainError("PAYMENT_BATCH_NOT_FOUND", "Payment batch not found", 404);
        await tx.execute(sql`SELECT id FROM payment_batches WHERE tenant_id = ${ctx.tenantId} AND id = ${locked.id} FOR UPDATE`);
        locked = await tx.query.paymentBatches.findFirst({ where: and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, batch.id)) });
        if (!locked) throw new DomainError("PAYMENT_BATCH_NOT_FOUND", "Payment batch not found", 404);
        const prior = await operationReceipt<{ batchPublicId: string; status: string; posted: Array<{ intakePublicId: string; transactionPublicIds: string[] }>; auditPublicIds: string[] }>(tx, ctx, "batch.execute", input.idempotencyKey, requestHash);
        if (prior) return presentExecutionReceipt(prior);
        if (locked.status === "posted") throw new DomainError("BATCH_IDEMPOTENCY_CONFLICT", "Payment batch was already executed with another idempotency key", 409);
        assertBatchEditable(locked);
        await assertBatchStagingComplete(ctx, locked, tx);
        const preview = await tx.query.paymentBatchPreviews.findFirst({ where: and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), eq(paymentBatchPreviews.publicId, input.previewPublicId), eq(paymentBatchPreviews.batchId, locked.id)) });
        if (!preview) throw new DomainError("BATCH_CONFIRMATION_STALE", "The batch preview no longer matches the confirmed semantics", 409);
        const items = await tx.select().from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, locked.id))).orderBy(asc(paymentBatchItems.itemOrder));
        const allocationRows = await tx.select().from(paymentBatchAllocations).where(and(eq(paymentBatchAllocations.tenantId, ctx.tenantId), eq(paymentBatchAllocations.previewId, preview.id))).orderBy(asc(paymentBatchAllocations.allocationOrder));
        await tx.execute(sql`SELECT id FROM payment_batch_previews WHERE tenant_id = ${ctx.tenantId} AND id = ${preview.id} FOR UPDATE`);
        // Every batch writer takes borrower locks in one deterministic order before
        // touching intakes, loans, or schedules. This is the cross-path deadlock
        // boundary shared with single-payment and reconciliation writers.
        const borrowerIds = [...new Set([
            ...(locked.borrowerId === null ? [] : [locked.borrowerId]),
            ...allocationRows.map((row) => row.borrowerId),
        ])].sort((left, right) => left - right);
        if (borrowerIds.some((id) => !initialBorrowerIds.includes(id))) throw new DomainError("BATCH_CONFIRMATION_STALE", "Borrower mapping changed while acquiring locks", 409);
        const lockedItems = await tx.select({ id: paymentBatchItems.id, paymentIntakeId: paymentBatchItems.paymentIntakeId }).from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, locked.id))).orderBy(asc(paymentBatchItems.id));
        const lockedIntakeIds = lockedItems.map((item) => item.paymentIntakeId).sort((a, b) => a - b);
        if (lockedIntakeIds.length) await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(lockedIntakeIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        const lockedIntakes = lockedIntakeIds.length ? await tx.select({ id: paymentIntakes.id, status: paymentIntakes.status, evidenceRequired: paymentIntakes.evidenceRequired }).from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, lockedIntakeIds))) : [];
        if (lockedIntakes.some((intake) => intake.status === "posted")) throw new DomainError("BATCH_EXECUTION_CONFLICT", "Some batch items were posted but the batch is not complete", 409);
        for (const intake of lockedIntakes) await assertPaymentEvidenceReady(tx, ctx.tenantId, intake);
        assertPaymentBatchPreviewFresh(preview, input);
        if (allocationRows.length) await tx.execute(sql`SELECT id FROM payment_batch_allocations WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(allocationRows.map((row) => sql`${row.id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        const loanIds = [...new Set(allocationRows.map((row) => row.loanId))].sort((a, b) => a - b);
        const scheduleIds = [...new Set(allocationRows.map((row) => row.scheduleId).filter((id): id is number => id !== null))].sort((a, b) => a - b);
        if (loanIds.length) await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(loanIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        if (scheduleIds.length) await tx.execute(sql`SELECT id FROM loan_schedules WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(scheduleIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        if (preview.version !== locked.version || preview.stateHash !== await batchSnapshot(tx, ctx.tenantId, locked.id, borrowerIds)) throw new DomainError("BATCH_CONFIRMATION_STALE", "Accounting, evidence or batch membership changed; preview again", 409);
        if (!preview.postingSequence || preview.allocationSnapshotHash !== allocationSnapshotHash(allocationRows, preview.postingSequence)) throw new DomainError("BATCH_CONFIRMATION_STALE", "Confirmed allocation snapshot changed; preview again", 409);
        await options.afterStage?.("locks");
        await options.afterStage?.("preview");
        const [borrowerRows, loanRows, scheduleRows, intakeRows] = await Promise.all([
            tx.select().from(borrowers).where(and(eq(borrowers.tenantId, ctx.tenantId), inArray(borrowers.id, borrowerIds))),
            tx.select().from(loans).where(and(eq(loans.tenantId, ctx.tenantId), inArray(loans.id, [...new Set(allocationRows.map((row) => row.loanId))]))),
            tx.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, ctx.tenantId), inArray(loanSchedules.id, scheduleIds))),
            tx.select().from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, items.map((item) => item.paymentIntakeId)))),
        ]);
        const evidenceRows = await tx.select().from(paymentEvidence).where(and(eq(paymentEvidence.tenantId, ctx.tenantId), inArray(paymentEvidence.paymentIntakeId, items.map((item) => item.paymentIntakeId))));
        const chronologyResults = await Promise.all(borrowerRows.map(async (borrower) => {
            const borrowerItems = items.filter((item) => allocationRows.some((allocation) => allocation.itemId === item.id && allocation.borrowerId === borrower.id));
            if (!borrowerItems.length) return null;
            const borrowerIntakes = intakeRows.filter((intake) => borrowerItems.some((item) => item.paymentIntakeId === intake.id));
            return inspectBatchChronology(ctx, locked, borrower.publicId, borrowerItems, borrowerIntakes, evidenceRows, tx);
        }));
        const chronology = chronologyResults.filter((result): result is NonNullable<typeof result> => result !== null).find((result) => result.status === "chronology_conflict") ?? null;
        if (chronology) throw new DomainError("PAYMENT_CHRONOLOGY_CONFLICT", "Payment chronology changed after preview", 409, { blockers: chronology.blockers, decisions: chronology.decisions });
        const posted: Array<{ intakePublicId: string; transactionPublicIds: string[] }> = [];
        items.sort((left, right) => intakeRows.find((row) => row.id === left.paymentIntakeId)!.receivedAt.getTime() - intakeRows.find((row) => row.id === right.paymentIntakeId)!.receivedAt.getTime() || left.publicId.localeCompare(right.publicId));
        if (digest(items.map((item) => item.publicId)) !== digest(preview.postingSequence)) throw new DomainError("BATCH_CONFIRMATION_STALE", "Posting sequence changed; preview again", 409);
        for (const item of items) {
            const intake = intakeRows.find((row) => row.id === item.paymentIntakeId);
            if (!intake) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
            const rows = allocationRows.filter((row) => row.itemId === item.id);
            const allocationInput = rows.map((row) => ({ borrowerPublicId: borrowerRows.find((borrower) => borrower.id === row.borrowerId)!.publicId, loanPublicId: loanRows.find((loan) => loan.id === row.loanId)!.publicId, ...(row.scheduleId === null ? {} : { schedulePublicId: scheduleRows.find((schedule) => schedule.id === row.scheduleId)!.publicId }), amount: row.amount }));
            const proposal = await previewPaymentMatch(ctx, intake.publicId, { allocations: allocationInput }, tx);
            const result = await postPaymentAllocationInTransaction(tx, ctx, intake, { proposalPublicId: proposal.publicId }, locked.publicId);
            if (result.transactions.length !== rows.length || rows.some((row, index) => {
                const posted = result.transactions[index]!;
                return ["principal", "interest", "fee", "penalty"].some((component) => row.calculatedComponents[component] !== posted[`${component}Component` as "principalComponent" | "interestComponent" | "feeComponent" | "penaltyComponent"]);
            })) throw new DomainError("BATCH_CONFIRMATION_STALE", "Accounting result differs from the confirmed allocation plan", 409);
            posted.push({ intakePublicId: intake.publicId, transactionPublicIds: result.transactions.map((transaction: { publicId: string }) => transaction.publicId) });
            await options.afterStage?.("item");
        }
        await tx.update(paymentBatchAllocations).set({ status: "posted" }).where(and(eq(paymentBatchAllocations.tenantId, ctx.tenantId), eq(paymentBatchAllocations.previewId, preview.id)));
        await tx.update(paymentBatchPreviews).set({ status: "posted" }).where(and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), eq(paymentBatchPreviews.id, preview.id)));
        const updated = await tx.update(paymentBatches).set({ status: "posted", executeIdempotencyKey: input.idempotencyKey, executeRequestHash: digest(input), postedAt: new Date(), updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, locked.id))).returning().then((rows) => rows[0]!);
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_batch", entityId: updated.publicId, action: "posted", payload: { batchPublicId: updated.publicId, intakePublicIds: posted.map((item) => item.intakePublicId), transactionPublicIds: posted.flatMap((item) => item.transactionPublicIds) } });
        await options.afterStage?.("all");
        return presentExecutionReceipt(await recordOperation(tx, ctx, updated, null, "batch.execute", input.idempotencyKey, requestHash, { batchPublicId: updated.publicId, status: "posted", posted, auditPublicIds: [audit.publicId] }));
    };
    return db.transaction(run);
}

export type { BatchObligation, BatchSlip };
