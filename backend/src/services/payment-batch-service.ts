import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { borrowers, loans, paymentBatchAllocations, paymentBatchItems, paymentBatchPreviews, paymentBatches, paymentEvidence, paymentIntakes, loanSchedules } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { canAccessTenantWideData } from "../lib/access";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { solvePaymentBatch } from "./payment-batch-solver";
import type { BatchObligation, BatchSlip, ExplicitBatchAllocation } from "./payment-batch-types";
import { postPaymentAllocationInTransaction, previewPaymentMatch } from "./payment-service";

type BatchRow = typeof paymentBatches.$inferSelect;
type ItemRow = typeof paymentBatchItems.$inferSelect;

function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function requireId(value: string, field: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400);
}
async function actor(ctx: CommandContext, executor: DbExecutor = db) {
    if (ctx.actorUserId === null) return null;
    const user = await executor.query.users.findFirst({ where: (users: any, { and, eq }: any) => and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)) });
    if (!user) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return user;
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

export async function createPaymentBatch(ctx: CommandContext, input: { idempotencyKey: string; borrowerPublicId?: string | null; notes?: string | null }) {
    await actor(ctx);
    const key = input.idempotencyKey.trim();
    if (!key) throw new DomainError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey must not be blank", 400);
    const existing = await db.query.paymentBatches.findFirst({ where: and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.createIdempotencyKey, key)) });
    if (existing) return view(ctx, existing);
    let borrowerId: number | null = null;
    if (input.borrowerPublicId) {
        requireId(input.borrowerPublicId, "borrowerPublicId");
        const borrower = await db.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, input.borrowerPublicId)) });
        if (!borrower) throw new DomainError("BORROWER_NOT_FOUND", "Borrower not found", 404);
        borrowerId = borrower.id;
    }
    const created = await db.transaction(async (tx) => {
        const row = await tx.insert(paymentBatches).values({ tenantId: ctx.tenantId, borrowerId, status: borrowerId ? "draft" : "needs_review", version: 0, stateHash: digest({ borrowerPublicId: input.borrowerPublicId ?? null, items: [] }), createIdempotencyKey: key, notes: input.notes ?? null, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_batch", entityId: row.publicId, action: "created", payload: { batchPublicId: row.publicId } });
        return row;
    });
    return view(ctx, created);
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
export async function cancelPaymentBatch(ctx: CommandContext, batchPublicId: string) {
    const batch = await accessibleBatch(ctx, batchPublicId);
    if (batch.status === "posted") throw new DomainError("PAYMENT_BATCH_NOT_EDITABLE", "Posted payment batches cannot be cancelled", 409);
    const updated = await db.update(paymentBatches).set({ status: "cancelled", updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, batch.id))).returning().then((rows) => rows[0]!);
    return view(ctx, updated);
}

export type PreviewPaymentBatchInput = { borrowerPublicId: string; allocations?: Array<ExplicitBatchAllocation> };
export async function previewPaymentBatch(ctx: CommandContext, batchPublicId: string, input: PreviewPaymentBatchInput) {
    const batch = await accessibleBatch(ctx, batchPublicId);
    requireId(input.borrowerPublicId, "borrowerPublicId");
    const borrower = await db.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, input.borrowerPublicId)) });
    if (!borrower) throw new DomainError("BORROWER_NOT_FOUND", "Borrower not found", 404);
    const items = await db.select().from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, batch.id))).orderBy(asc(paymentBatchItems.itemOrder));
    if (!items.length) throw new DomainError("BATCH_ITEMS_REQUIRED", "Payment batch must contain at least one item", 409);
    const intakes = await db.select().from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, items.map((item) => item.paymentIntakeId))));
    const evidence = await db.select().from(paymentEvidence).where(and(eq(paymentEvidence.tenantId, ctx.tenantId), inArray(paymentEvidence.paymentIntakeId, items.map((item) => item.paymentIntakeId))));
    const evidenceReady = items.every((item) => evidence.some((entry) => entry.paymentIntakeId === item.paymentIntakeId && entry.status === "ready"));
    const loansForBorrower = (await db.select().from(loans).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.borrowerId, borrower.id), eq(loans.status, "active")))).filter((loan) => loan.repaymentType !== "floating");
    const schedules = loansForBorrower.length ? await db.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, ctx.tenantId), inArray(loanSchedules.loanId, loansForBorrower.map((loan) => loan.id)))) : [];
    const obligations: BatchObligation[] = schedules.filter((schedule) => schedule.status !== "paid" && schedule.remainingDue !== "0").map((schedule) => {
        const loan = loansForBorrower.find((candidate) => candidate.id === schedule.loanId)!;
        return { borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, schedulePublicId: schedule.publicId, dueDate: schedule.dueDate, remainingDue: schedule.remainingDue, principalDue: schedule.scheduledPrincipal, interestDue: schedule.scheduledInterest, feeDue: schedule.scheduledFee, penaltyDue: "0.00" };
    });
    const slips: BatchSlip[] = items.map((item) => { const intake = intakes.find((candidate) => candidate.id === item.paymentIntakeId)!; return { itemPublicId: item.publicId, amount: intake.amount, receivedAt: intake.receivedAt.toISOString() }; });
    const solved = input.allocations ? { status: "ready" as const, allocations: input.allocations.map((allocation) => ({ ...allocation, matchSource: "human_explicit" as const })), candidates: [], warnings: [] } : solvePaymentBatch({ obligations, slips });
    const amountByItem = new Map(slips.map((slip) => [slip.itemPublicId, slip.amount]));
    for (const allocation of solved.allocations) {
        if (!obligations.some((obligation) => obligation.schedulePublicId === allocation.schedulePublicId && obligation.loanPublicId === allocation.loanPublicId)) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Allocation target is not an eligible active scheduled loan", 409);
    }
    const allocatedByItem = new Map<string, Decimal>();
    for (const allocation of solved.allocations) allocatedByItem.set(allocation.itemPublicId, (allocatedByItem.get(allocation.itemPublicId) ?? new Decimal(0)).plus(allocation.amount));
    if (input.allocations && solved.allocations.some((allocation) => allocatedByItem.get(allocation.itemPublicId)?.toFixed(2) !== amountByItem.get(allocation.itemPublicId))) throw new DomainError("BATCH_ALLOCATION_MISMATCH", "Every payment intake must be allocated exactly", 409);
    const semantic = solved.allocations.map(({ itemPublicId, loanPublicId, schedulePublicId, amount, targetDueDate, intent }) => ({ itemPublicId, loanPublicId, schedulePublicId, amount, targetDueDate, intent }));
    const stateHash = `v1:${digest({ borrowerPublicId: borrower.publicId, obligations })}`;
    const confirmationHash = `v1:${digest({ batchPublicId: batch.publicId, items: slips, allocations: semantic, warnings: solved.warnings.map((warning) => warning.code) })}`;
    const previewHash = `v1:${digest({ stateHash, confirmationHash, candidates: solved.candidates })}`;
    const nextVersion = batch.version + 1;
    const status = solved.status === "ready" && evidenceReady ? "ready" : "needs_review";
    const created = await db.transaction(async (tx) => {
        await tx.update(paymentBatchPreviews).set({ status: "stale" }).where(and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), eq(paymentBatchPreviews.batchId, batch.id), eq(paymentBatchPreviews.status, "ready")));
        const preview = await tx.insert(paymentBatchPreviews).values({ tenantId: ctx.tenantId, batchId: batch.id, version: nextVersion, status, stateHash, previewHash, confirmationHash, warnings: solved.warnings, candidates: solved.candidates, evidenceReady, expiresAt: new Date(Date.now() + 15 * 60 * 1000), createdByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        if (solved.allocations.length) await tx.insert(paymentBatchAllocations).values(solved.allocations.map((allocation, index) => { const loan = loansForBorrower.find((candidate) => candidate.publicId === allocation.loanPublicId)!; const schedule = schedules.find((candidate) => candidate.publicId === allocation.schedulePublicId)!; const item = items.find((candidate) => candidate.publicId === allocation.itemPublicId)!; return { tenantId: ctx.tenantId, previewId: preview.id, itemId: item.id, allocationOrder: index + 1, borrowerId: borrower.id, loanId: loan.id, scheduleId: schedule.id, amount: allocation.amount, targetDueDate: allocation.targetDueDate, intent: allocation.intent, calculatedComponents: { principal: allocation.amount, interest: "0.00", fee: "0.00", penalty: "0.00" } }; }));
        await tx.update(paymentBatches).set({ borrowerId: borrower.id, status, version: nextVersion, stateHash, confirmationHash: status === "ready" ? confirmationHash : null, updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, batch.id)));
        return preview;
    });
    return { id: created.publicId, publicId: created.publicId, batchPublicId: batch.publicId, version: created.version, status, stateHash, previewHash, confirmationHash, evidenceReady, allocations: solved.allocations, candidates: solved.candidates, warnings: solved.warnings };
}
export type PaymentBatchExecutionOptions = { afterStage?: (stage: "locks" | "preview" | "item" | "all") => Promise<void> | void };

export async function executePaymentBatch(ctx: CommandContext, batchPublicId: string, input: { previewPublicId: string; previewHash: string; confirmationHash: string; confirmed: true; idempotencyKey: string }, options: PaymentBatchExecutionOptions = {}) {
    const batch = await accessibleBatch(ctx, batchPublicId);
    if (batch.status === "posted" && batch.executeIdempotencyKey === input.idempotencyKey) return { batchPublicId: batch.publicId, status: "posted", auditPublicIds: [], correlationId: ctx.correlationId };
    if (!input.confirmed) throw new DomainError("BATCH_CONFIRMATION_REQUIRED", "Batch execution requires explicit confirmation", 409);
    requireId(input.previewPublicId, "previewPublicId");
    const run = async (tx: DbExecutor) => {
        let locked = await tx.query.paymentBatches.findFirst({ where: and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, batch.id)) });
        if (!locked) throw new DomainError("PAYMENT_BATCH_NOT_FOUND", "Payment batch not found", 404);
        if (locked.status === "posted" && locked.executeIdempotencyKey === input.idempotencyKey) return { batchPublicId: locked.publicId, status: "posted", auditPublicIds: [], correlationId: ctx.correlationId };
        if (locked.status === "posted") throw new DomainError("BATCH_IDEMPOTENCY_CONFLICT", "Payment batch was already executed with another idempotency key", 409);
        await tx.execute(sql`SELECT id FROM payment_batches WHERE tenant_id = ${ctx.tenantId} AND id = ${locked.id} FOR UPDATE`);
        locked = await tx.query.paymentBatches.findFirst({ where: and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, batch.id)) });
        if (!locked) throw new DomainError("PAYMENT_BATCH_NOT_FOUND", "Payment batch not found", 404);
        if (locked.status === "posted" && locked.executeIdempotencyKey === input.idempotencyKey) return { batchPublicId: locked.publicId, status: "posted", auditPublicIds: [], correlationId: ctx.correlationId };
        if (locked.status === "posted") throw new DomainError("BATCH_IDEMPOTENCY_CONFLICT", "Payment batch was already executed with another idempotency key", 409);
        const preview = await tx.query.paymentBatchPreviews.findFirst({ where: and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), eq(paymentBatchPreviews.publicId, input.previewPublicId), eq(paymentBatchPreviews.batchId, locked.id)) });
        if (!preview) throw new DomainError("BATCH_CONFIRMATION_STALE", "The batch preview no longer matches the confirmed semantics", 409);
        const items = await tx.select().from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, locked.id))).orderBy(asc(paymentBatchItems.itemOrder));
        const allocationRows = await tx.select().from(paymentBatchAllocations).where(and(eq(paymentBatchAllocations.tenantId, ctx.tenantId), eq(paymentBatchAllocations.previewId, preview.id))).orderBy(asc(paymentBatchAllocations.allocationOrder));
        await tx.execute(sql`SELECT id FROM payment_batch_previews WHERE tenant_id = ${ctx.tenantId} AND id = ${preview.id} FOR UPDATE`);
        const lockedItems = await tx.select({ id: paymentBatchItems.id, paymentIntakeId: paymentBatchItems.paymentIntakeId }).from(paymentBatchItems).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.batchId, locked.id))).orderBy(asc(paymentBatchItems.id));
        const lockedIntakeIds = lockedItems.map((item) => item.paymentIntakeId).sort((a, b) => a - b);
        if (lockedIntakeIds.length) await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(lockedIntakeIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        const lockedIntakes = lockedIntakeIds.length ? await tx.select({ id: paymentIntakes.id, status: paymentIntakes.status }).from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, lockedIntakeIds))) : [];
        if (lockedIntakes.length === lockedIntakeIds.length && lockedIntakes.every((intake) => intake.status === "posted")) return { batchPublicId: locked.publicId, status: "posted", auditPublicIds: [], correlationId: ctx.correlationId };
        if (lockedIntakes.some((intake) => intake.status === "posted")) throw new DomainError("BATCH_EXECUTION_CONFLICT", "Some batch items were posted but the batch is not complete", 409);
        if (preview.status !== "ready" || preview.previewHash !== input.previewHash || preview.confirmationHash !== input.confirmationHash) throw new DomainError("BATCH_CONFIRMATION_STALE", "The batch preview no longer matches the confirmed semantics", 409);
        if (allocationRows.length) await tx.execute(sql`SELECT id FROM payment_batch_allocations WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(allocationRows.map((row) => sql`${row.id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        const loanIds = [...new Set(allocationRows.map((row) => row.loanId))].sort((a, b) => a - b);
        const scheduleIds = [...new Set(allocationRows.map((row) => row.scheduleId))].sort((a, b) => a - b);
        if (loanIds.length) await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(loanIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        if (scheduleIds.length) await tx.execute(sql`SELECT id FROM loan_schedules WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(scheduleIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        await options.afterStage?.("locks");
        await options.afterStage?.("preview");
        const [borrowerRows, loanRows, scheduleRows, intakeRows] = await Promise.all([
            tx.select().from(borrowers).where(and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.id, locked.borrowerId!))),
            tx.select().from(loans).where(and(eq(loans.tenantId, ctx.tenantId), inArray(loans.id, [...new Set(allocationRows.map((row) => row.loanId))]))),
            tx.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, ctx.tenantId), inArray(loanSchedules.id, [...new Set(allocationRows.map((row) => row.scheduleId))]))),
            tx.select().from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, items.map((item) => item.paymentIntakeId)))),
        ]);
        const posted: Array<{ intakePublicId: string; transactionPublicIds: string[] }> = [];
        for (const item of items) {
            const intake = intakeRows.find((row) => row.id === item.paymentIntakeId);
            if (!intake) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
            const rows = allocationRows.filter((row) => row.itemId === item.id);
            const allocationInput = rows.map((row) => ({ borrowerPublicId: borrowerRows[0]!.publicId, loanPublicId: loanRows.find((loan) => loan.id === row.loanId)!.publicId, schedulePublicId: scheduleRows.find((schedule) => schedule.id === row.scheduleId)!.publicId, amount: row.amount }));
            const proposal = await previewPaymentMatch(ctx, intake.publicId, { allocations: allocationInput }, tx);
            const result = await postPaymentAllocationInTransaction(tx, ctx, intake, { proposalPublicId: proposal.publicId });
            posted.push({ intakePublicId: intake.publicId, transactionPublicIds: result.transactions.map((transaction: { publicId: string }) => transaction.publicId) });
            await options.afterStage?.("item");
        }
        await tx.update(paymentBatchAllocations).set({ status: "posted" }).where(and(eq(paymentBatchAllocations.tenantId, ctx.tenantId), eq(paymentBatchAllocations.previewId, preview.id)));
        await tx.update(paymentBatchPreviews).set({ status: "posted" }).where(and(eq(paymentBatchPreviews.tenantId, ctx.tenantId), eq(paymentBatchPreviews.id, preview.id)));
        const updated = await tx.update(paymentBatches).set({ status: "posted", executeIdempotencyKey: input.idempotencyKey, executeRequestHash: digest(input), postedAt: new Date(), updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, locked.id))).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_batch", entityId: updated.publicId, action: "posted", payload: { batchPublicId: updated.publicId, intakePublicIds: posted.map((item) => item.intakePublicId), transactionPublicIds: posted.flatMap((item) => item.transactionPublicIds) } });
        await options.afterStage?.("all");
        return { batchPublicId: updated.publicId, status: "posted", posted, auditPublicIds: [], correlationId: ctx.correlationId };
    };
    return db.transaction(run);
}

export type { BatchObligation, BatchSlip };
