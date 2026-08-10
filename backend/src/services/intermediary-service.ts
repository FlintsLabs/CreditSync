import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, intermediaries, intermediaryCollections, intermediaryRemittanceAllocations, intermediaryRemittanceProposals, intermediaryRemittances, loans, paymentIntakes, users } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { canAccessTenantWideData } from "../lib/access";
import { parseMoney, serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { postPayment, previewPaymentMatch, reversePayment } from "./payment-service";

export function normalizeIntermediaryText(value: string) {
    return value.normalize("NFKC").toLocaleLowerCase("und")
        .replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function referenceHash(value?: string | null) {
    const normalized = value?.normalize("NFKC").toLocaleLowerCase("und").replace(/[\p{P}\p{S}\s]+/gu, "") ?? "";
    return normalized ? createHash("sha256").update(normalized).digest("hex") : null;
}

function auditContext(ctx: CommandContext) {
    return { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId };
}

async function actorFor(ctx: CommandContext) {
    if (ctx.actorUserId === null) return null;
    const actor = await db.query.users.findFirst({ where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)) });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

function presentIntermediary(row: typeof intermediaries.$inferSelect) {
    return { publicId: row.publicId, name: row.name, aliases: row.aliases, notes: row.notes, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function presentCollection(row: typeof intermediaryCollections.$inferSelect) {
    return { publicId: row.publicId, intermediaryId: row.intermediaryId, borrowerId: row.borrowerId, loanId: row.loanId, amount: serializeMoney(row.amount), borrowerPaidAt: row.borrowerPaidAt.toISOString(), status: row.status, bankReference: row.bankReference, note: row.note, manualApprovalReason: row.manualApprovalReason, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export async function createIntermediary(ctx: CommandContext, input: { name: string; aliases?: string[]; notes?: string | null }) {
    const name = input.name?.trim();
    const normalizedName = normalizeIntermediaryText(name ?? "");
    if (!name || !normalizedName) throw new DomainError("INVALID_INTERMEDIARY", "Intermediary name is required", 400);
    await actorFor(ctx);
    const existing = await db.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.normalizedName, normalizedName)) });
    if (existing) return presentIntermediary(existing);
    return db.transaction(async (tx) => {
        const row = await tx.insert(intermediaries).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, name, normalizedName, aliases: input.aliases ?? [], notes: input.notes ?? null, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        const after = presentIntermediary(row);
        await createAuditLog(tx, { ...auditContext(ctx), entityType: "intermediary", entityId: row.publicId, action: "created", payload: { before: null, after } });
        return after;
    });
}

export async function listIntermediaries(ctx: CommandContext, status: "active" | "inactive" | "all" = "active") {
    const actor = await actorFor(ctx);
    const conditions = [eq(intermediaries.tenantId, ctx.tenantId)];
    if (status !== "all") conditions.push(eq(intermediaries.status, status));
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) conditions.push(eq(intermediaries.ownerUserId, actor.id));
    return (await db.select().from(intermediaries).where(and(...conditions))).map(presentIntermediary);
}

export async function searchIntermediaries(ctx: CommandContext, query: string) {
    const normalized = normalizeIntermediaryText(query);
    const rows = await listIntermediaries(ctx, "active");
    return rows.filter((row) => normalizeIntermediaryText(row.name).includes(normalized) || row.aliases.some((alias) => normalizeIntermediaryText(alias).includes(normalized)));
}

export async function updateIntermediary(ctx: CommandContext, publicId: string, changes: { name?: string; aliases?: string[]; notes?: string | null; status?: "active" | "inactive" }) {
    await actorFor(ctx);
    const existing = await db.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.publicId, publicId)) });
    if (!existing) throw new DomainError("INTERMEDIARY_NOT_FOUND", "Intermediary not found", 404);
    const name = changes.name?.trim();
    if (changes.name !== undefined && !name) throw new DomainError("INVALID_INTERMEDIARY", "Intermediary name is required", 400);
    return db.transaction(async (tx) => {
        const row = await tx.update(intermediaries).set({ ...changes, ...(name ? { name, normalizedName: normalizeIntermediaryText(name) } : {}), updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(eq(intermediaries.id, existing.id)).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, { ...auditContext(ctx), entityType: "intermediary", entityId: row.publicId, action: "updated", payload: { before: presentIntermediary(existing), after: presentIntermediary(row) } });
        return presentIntermediary(row);
    });
}

export interface CreateIntermediaryCollectionInput {
    intermediaryPublicId: string;
    borrowerPublicId: string;
    loanPublicId: string;
    amount: string;
    borrowerPaidAt: string;
    bankReference?: string | null;
    note?: string | null;
}

export async function createIntermediaryCollection(ctx: CommandContext, input: CreateIntermediaryCollectionInput) {
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400);
    const amount = parseMoney(input.amount);
    if (!amount.gt(0)) throw new DomainError("INVALID_COLLECTION_AMOUNT", "Collection amount must be greater than zero", 400);
    const borrowerPaidAt = new Date(input.borrowerPaidAt);
    if (Number.isNaN(borrowerPaidAt.getTime())) throw new DomainError("INVALID_BORROWER_PAID_AT", "Borrower paid time must be ISO 8601", 400);
    const actor = await actorFor(ctx);
    const replay = await db.query.intermediaryCollections.findFirst({ where: and(eq(intermediaryCollections.tenantId, ctx.tenantId), eq(intermediaryCollections.idempotencyKey, idempotencyKey)) });
    if (replay) return presentCollection(replay);
    const [intermediary, borrower, loan] = await Promise.all([
        db.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.publicId, input.intermediaryPublicId)) }),
        db.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, input.borrowerPublicId)) }),
        db.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, input.loanPublicId)) }),
    ]);
    if (!intermediary) throw new DomainError("INTERMEDIARY_NOT_FOUND", "Intermediary not found", 404);
    if (!borrower || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && borrower.ownerUserId !== actor.id)) throw new DomainError("BORROWER_NOT_FOUND", "Borrower not found", 404);
    if (!loan || loan.borrowerId !== borrower.id || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && loan.ownerUserId !== actor.id)) throw new DomainError("LOAN_NOT_FOUND", "Loan not found for borrower", 404);
    return db.transaction(async (tx) => {
        const row = await tx.insert(intermediaryCollections).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, intermediaryId: intermediary.id, borrowerId: borrower.id, loanId: loan.id, amount: serializeMoney(amount), borrowerPaidAt, status: "pending_remittance", idempotencyKey, bankReference: input.bankReference?.trim() || null, bankReferenceHash: referenceHash(input.bankReference), note: input.note?.trim() || null, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        const after = presentCollection(row);
        await createAuditLog(tx, { ...auditContext(ctx), entityType: "intermediary_collection", entityId: row.publicId, action: "created", payload: { before: null, after } });
        return after;
    });
}

export async function getIntermediaryCollection(ctx: CommandContext, publicId: string) {
    await actorFor(ctx);
    const row = await db.query.intermediaryCollections.findFirst({ where: and(eq(intermediaryCollections.tenantId, ctx.tenantId), eq(intermediaryCollections.publicId, publicId)) });
    if (!row) throw new DomainError("INTERMEDIARY_COLLECTION_NOT_FOUND", "Intermediary collection not found", 404);
    return presentCollection(row);
}

export async function listIntermediaryCollections(ctx: CommandContext, filters: { intermediaryPublicId?: string; status?: string } = {}) {
    await actorFor(ctx);
    const conditions = [eq(intermediaryCollections.tenantId, ctx.tenantId)];
    if (filters.status) conditions.push(eq(intermediaryCollections.status, filters.status));
    if (filters.intermediaryPublicId) {
        const intermediary = await db.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.publicId, filters.intermediaryPublicId)) });
        if (!intermediary) return [];
        conditions.push(eq(intermediaryCollections.intermediaryId, intermediary.id));
    }
    return (await db.select().from(intermediaryCollections).where(and(...conditions))).map(presentCollection);
}

function presentRemittance(row: typeof intermediaryRemittances.$inferSelect, selected = new Decimal(0)) {
    const gross = new Decimal(row.grossAmount);
    return { publicId: row.publicId, status: row.status, grossAmount: serializeMoney(gross), selectedTotal: serializeMoney(selected), remainingBalance: gross.minus(selected).toFixed(2), receivedAt: row.receivedAt.toISOString(), bankReference: row.bankReference, destinationHint: row.destinationHint, note: row.note, postedAt: row.postedAt, reversedAt: row.reversedAt };
}

export async function createIntermediaryRemittance(ctx: CommandContext, input: { intermediaryPublicId: string; grossAmount: string; receivedAt: string; bankReference?: string | null; destinationHint?: string | null; note?: string | null }) {
    const key = ctx.idempotencyKey?.trim();
    if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400);
    const gross = parseMoney(input.grossAmount);
    if (!gross.gt(0)) throw new DomainError("INVALID_REMITTANCE_AMOUNT", "Remittance amount must be greater than zero", 400);
    const receivedAt = new Date(input.receivedAt);
    if (Number.isNaN(receivedAt.getTime())) throw new DomainError("INVALID_REMITTANCE_RECEIVED_AT", "Received time must be ISO 8601", 400);
    await actorFor(ctx);
    const replay = await db.query.intermediaryRemittances.findFirst({ where: and(eq(intermediaryRemittances.tenantId, ctx.tenantId), eq(intermediaryRemittances.idempotencyKey, key)) });
    if (replay) return presentRemittance(replay);
    const intermediary = await db.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.publicId, input.intermediaryPublicId), eq(intermediaries.status, "active")) });
    if (!intermediary) throw new DomainError("INTERMEDIARY_NOT_FOUND", "Intermediary not found", 404);
    return db.transaction(async (tx) => {
        const row = await tx.insert(intermediaryRemittances).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, intermediaryId: intermediary.id, grossAmount: serializeMoney(gross), receivedAt, bankReference: input.bankReference?.trim() || null, bankReferenceHash: referenceHash(input.bankReference), destinationHint: input.destinationHint?.trim() || null, note: input.note?.trim() || null, idempotencyKey: key, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, { ...auditContext(ctx), entityType: "intermediary_remittance", entityId: row.publicId, action: "created", payload: { before: null, after: presentRemittance(row) } });
        return presentRemittance(row);
    });
}

export async function getIntermediaryRemittance(ctx: CommandContext, publicId: string) {
    await actorFor(ctx);
    const row = await db.query.intermediaryRemittances.findFirst({ where: and(eq(intermediaryRemittances.tenantId, ctx.tenantId), eq(intermediaryRemittances.publicId, publicId)) });
    if (!row) throw new DomainError("INTERMEDIARY_REMITTANCE_NOT_FOUND", "Remittance not found", 404);
    const selection = await remittanceSelection(db, ctx.tenantId, row.id);
    return { ...presentRemittance(row, selection.selected), collectionPublicIds: selection.collections.map((collection: typeof intermediaryCollections.$inferSelect) => collection.publicId) };
}

export async function listIntermediaryRemittances(ctx: CommandContext, filters: { intermediaryPublicId?: string; status?: string } = {}) {
    await actorFor(ctx);
    const conditions = [eq(intermediaryRemittances.tenantId, ctx.tenantId)];
    if (filters.status) conditions.push(eq(intermediaryRemittances.status, filters.status));
    if (filters.intermediaryPublicId) {
        const intermediary = await db.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.publicId, filters.intermediaryPublicId)) });
        if (!intermediary) return [];
        conditions.push(eq(intermediaryRemittances.intermediaryId, intermediary.id));
    }
    const rows = await db.select().from(intermediaryRemittances).where(and(...conditions)).orderBy(desc(intermediaryRemittances.receivedAt));
    return Promise.all(rows.map(async (row: typeof intermediaryRemittances.$inferSelect) => {
        const selection = await remittanceSelection(db, ctx.tenantId, row.id);
        return presentRemittance(row, selection.selected);
    }));
}

async function remittanceSelection(executor: any, tenantId: string, remittanceId: number) {
    const allocations = await executor.select().from(intermediaryRemittanceAllocations).where(and(eq(intermediaryRemittanceAllocations.tenantId, tenantId), eq(intermediaryRemittanceAllocations.remittanceId, remittanceId), sql`${intermediaryRemittanceAllocations.releasedAt} IS NULL`)).orderBy(intermediaryRemittanceAllocations.allocationOrder);
    const collections = allocations.length ? await executor.select().from(intermediaryCollections).where(and(eq(intermediaryCollections.tenantId, tenantId), inArray(intermediaryCollections.id, allocations.map((row: typeof intermediaryRemittanceAllocations.$inferSelect) => row.collectionId)))) : [];
    return { allocations, collections, selected: collections.reduce((sum: Decimal, row: typeof intermediaryCollections.$inferSelect) => sum.plus(row.amount), new Decimal(0)) };
}

export async function saveRemittanceAllocations(ctx: CommandContext, publicId: string, input: { collectionPublicIds: string[] }) {
    await actorFor(ctx);
    if (new Set(input.collectionPublicIds).size !== input.collectionPublicIds.length) throw new DomainError("DUPLICATE_COLLECTION_SELECTION", "Collection selection contains duplicates", 400);
    return db.transaction(async (tx) => {
        const remittance = await tx.query.intermediaryRemittances.findFirst({ where: and(eq(intermediaryRemittances.tenantId, ctx.tenantId), eq(intermediaryRemittances.publicId, publicId)) });
        if (!remittance) throw new DomainError("INTERMEDIARY_REMITTANCE_NOT_FOUND", "Remittance not found", 404);
        if (!['draft', 'needs_review', 'ready'].includes(remittance.status)) throw new DomainError("INTERMEDIARY_REMITTANCE_IMMUTABLE", "Remittance cannot be edited", 409);
        await tx.execute(sql`SELECT id FROM intermediary_remittances WHERE id = ${remittance.id} FOR UPDATE`);
        const selected = input.collectionPublicIds.length ? await tx.select().from(intermediaryCollections).where(and(eq(intermediaryCollections.tenantId, ctx.tenantId), inArray(intermediaryCollections.publicId, input.collectionPublicIds))) : [];
        if (selected.length !== input.collectionPublicIds.length || selected.some((row: typeof intermediaryCollections.$inferSelect) => row.intermediaryId !== remittance.intermediaryId || !['pending_remittance', 'allocated'].includes(row.status))) throw new DomainError("INVALID_COLLECTION_SELECTION", "Every collection must be pending for this intermediary", 409);
        const priorAllocations = await tx.select().from(intermediaryRemittanceAllocations).where(and(eq(intermediaryRemittanceAllocations.tenantId, ctx.tenantId), eq(intermediaryRemittanceAllocations.remittanceId, remittance.id)));
        const selectedIds = new Set(selected.map((row: typeof intermediaryCollections.$inferSelect) => row.id));
        const releasedIds = priorAllocations.filter((row: typeof intermediaryRemittanceAllocations.$inferSelect) => row.releasedAt === null && !selectedIds.has(row.collectionId)).map((row: typeof intermediaryRemittanceAllocations.$inferSelect) => row.collectionId);
        if (releasedIds.length) {
            await tx.update(intermediaryRemittanceAllocations).set({ releasedAt: new Date() }).where(and(eq(intermediaryRemittanceAllocations.tenantId, ctx.tenantId), eq(intermediaryRemittanceAllocations.remittanceId, remittance.id), inArray(intermediaryRemittanceAllocations.collectionId, releasedIds)));
            await tx.update(intermediaryCollections).set({ status: "pending_remittance", updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(intermediaryCollections.tenantId, ctx.tenantId), inArray(intermediaryCollections.id, releasedIds)));
        }
        for (const [index, publicId] of input.collectionPublicIds.entries()) {
            const collectionId = selected.find((row: typeof intermediaryCollections.$inferSelect) => row.publicId === publicId)!.id;
            const prior = priorAllocations.find((row: typeof intermediaryRemittanceAllocations.$inferSelect) => row.collectionId === collectionId);
            if (prior) await tx.update(intermediaryRemittanceAllocations).set({ releasedAt: null, allocationOrder: index + 1 }).where(eq(intermediaryRemittanceAllocations.id, prior.id));
            else await tx.insert(intermediaryRemittanceAllocations).values({ tenantId: ctx.tenantId, remittanceId: remittance.id, collectionId, allocationOrder: index + 1, createdByUserId: ctx.actorUserId });
        }
        if (selected.length) await tx.update(intermediaryCollections).set({ status: "allocated", updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(inArray(intermediaryCollections.id, selected.map((row: typeof intermediaryCollections.$inferSelect) => row.id)));
        const total = selected.reduce((sum: Decimal, row: typeof intermediaryCollections.$inferSelect) => sum.plus(row.amount), new Decimal(0));
        const status = total.eq(remittance.grossAmount) ? "ready" : "needs_review";
        const updated = await tx.update(intermediaryRemittances).set({ status, updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(eq(intermediaryRemittances.id, remittance.id)).returning().then((rows) => rows[0]!);
        return { ...presentRemittance(updated, total), collectionPublicIds: input.collectionPublicIds };
    });
}

export async function previewIntermediaryRemittance(ctx: CommandContext, publicId: string) {
    await actorFor(ctx);
    return db.transaction(async (tx) => {
        const remittance = await tx.query.intermediaryRemittances.findFirst({ where: and(eq(intermediaryRemittances.tenantId, ctx.tenantId), eq(intermediaryRemittances.publicId, publicId)) });
        if (!remittance) throw new DomainError("INTERMEDIARY_REMITTANCE_NOT_FOUND", "Remittance not found", 404);
        const selection = await remittanceSelection(tx, ctx.tenantId, remittance.id);
        const remaining = new Decimal(remittance.grossAmount).minus(selection.selected);
        const status = remaining.isZero() && selection.collections.length ? "ready" : "needs_review";
        const prior = await tx.select().from(intermediaryRemittanceProposals).where(and(eq(intermediaryRemittanceProposals.tenantId, ctx.tenantId), eq(intermediaryRemittanceProposals.remittanceId, remittance.id))).orderBy(desc(intermediaryRemittanceProposals.version));
        if (prior.length) await tx.update(intermediaryRemittanceProposals).set({ status: "stale" }).where(inArray(intermediaryRemittanceProposals.id, prior.filter((row: typeof intermediaryRemittanceProposals.$inferSelect) => ['ready', 'needs_review'].includes(row.status)).map((row: typeof intermediaryRemittanceProposals.$inferSelect) => row.id)));
        const stateHash = createHash("sha256").update(JSON.stringify({ remittance: remittance.publicId, gross: serializeMoney(remittance.grossAmount), collections: selection.collections.map((row: typeof intermediaryCollections.$inferSelect) => [row.publicId, serializeMoney(row.amount), row.status]) })).digest("hex");
        const proposal = await tx.insert(intermediaryRemittanceProposals).values({ tenantId: ctx.tenantId, remittanceId: remittance.id, version: (prior[0]?.version ?? 0) + 1, status, selectedTotal: serializeMoney(selection.selected), remainingBalance: remaining.toFixed(2), stateHash, warnings: remaining.isZero() ? [] : [{ code: remaining.gt(0) ? "REMITTANCE_UNDER_ALLOCATED" : "REMITTANCE_OVER_ALLOCATED", amount: remaining.abs().toFixed(2) }], expiresAt: new Date(Date.now() + 15 * 60_000), createdByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        return { publicId: proposal.publicId, version: proposal.version, status, grossAmount: serializeMoney(remittance.grossAmount), selectedTotal: serializeMoney(selection.selected), remainingBalance: remaining.toFixed(2), warnings: proposal.warnings, expiresAt: proposal.expiresAt, collectionPublicIds: selection.collections.map((row: typeof intermediaryCollections.$inferSelect) => row.publicId) };
    });
}

export async function postIntermediaryRemittance(ctx: CommandContext, publicId: string, input: { proposalPublicId: string; confirmed: boolean }) {
    if (!input.confirmed) throw new DomainError("REMITTANCE_CONFIRMATION_REQUIRED", "Explicit confirmation is required", 400);
    const postKey = ctx.idempotencyKey?.trim();
    if (!postKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400);
    await actorFor(ctx);
    const result = await db.transaction(async (tx) => {
        const remittance = await tx.query.intermediaryRemittances.findFirst({ where: and(eq(intermediaryRemittances.tenantId, ctx.tenantId), eq(intermediaryRemittances.publicId, publicId)) });
        if (!remittance) throw new DomainError("INTERMEDIARY_REMITTANCE_NOT_FOUND", "Remittance not found", 404);
        await tx.execute(sql`SELECT id FROM intermediary_remittances WHERE id = ${remittance.id} FOR UPDATE`);
        if (remittance.status === "posted") {
            if (remittance.postIdempotencyKey !== postKey) throw new DomainError("REMITTANCE_POST_IDEMPOTENCY_CONFLICT", "Remittance was posted with a different idempotency key", 409);
            return presentRemittance(remittance, new Decimal(remittance.grossAmount));
        }
        const proposal = await tx.query.intermediaryRemittanceProposals.findFirst({ where: and(eq(intermediaryRemittanceProposals.tenantId, ctx.tenantId), eq(intermediaryRemittanceProposals.publicId, input.proposalPublicId), eq(intermediaryRemittanceProposals.remittanceId, remittance.id)) });
        if (!proposal || proposal.status !== "ready" || proposal.expiresAt.getTime() < Date.now()) throw new DomainError("STALE_REMITTANCE_PROPOSAL", "Remittance proposal is not ready or has expired", 409);
        const latest = await tx.select().from(intermediaryRemittanceProposals).where(and(eq(intermediaryRemittanceProposals.tenantId, ctx.tenantId), eq(intermediaryRemittanceProposals.remittanceId, remittance.id))).orderBy(desc(intermediaryRemittanceProposals.version)).then((rows) => rows[0]);
        if (latest?.id !== proposal.id) throw new DomainError("STALE_REMITTANCE_PROPOSAL", "A newer remittance proposal exists", 409);
        const selection = await remittanceSelection(tx, ctx.tenantId, remittance.id);
        if (!selection.selected.eq(remittance.grossAmount) || selection.collections.length === 0) throw new DomainError("REMITTANCE_BALANCE_NOT_ZERO", "Selected collections must exactly equal the remittance", 409);
        const currentHash = createHash("sha256").update(JSON.stringify({ remittance: remittance.publicId, gross: serializeMoney(remittance.grossAmount), collections: selection.collections.map((row: typeof intermediaryCollections.$inferSelect) => [row.publicId, serializeMoney(row.amount), row.status]) })).digest("hex");
        if (currentHash !== proposal.stateHash) throw new DomainError("STALE_REMITTANCE_PROPOSAL", "Remittance proposal no longer matches current state", 409);
        await tx.execute(sql`SELECT id FROM intermediary_collections WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(selection.collections.map((row: typeof intermediaryCollections.$inferSelect) => sql`${row.id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        for (const collection of selection.collections) {
            if (collection.status !== "allocated") throw new DomainError("STALE_REMITTANCE_PROPOSAL", "A selected collection is no longer allocated", 409);
            const [borrower, loan] = await Promise.all([
                tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.id, collection.borrowerId)) }),
                tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, collection.loanId)) }),
            ]);
            if (!borrower || !loan) throw new DomainError("STALE_REMITTANCE_PROPOSAL", "Collection target no longer exists", 409);
            const intake = await tx.insert(paymentIntakes).values({ tenantId: ctx.tenantId, ownerUserId: collection.ownerUserId, source: ctx.actorSource === "mcp" ? "mcp" : "web", status: "draft", amount: serializeMoney(collection.amount), receivedAt: collection.borrowerPaidAt, payerName: borrower.name, bankReference: collection.bankReference, bankReferenceHash: collection.bankReferenceHash, idempotencyKey: `intermediary:${collection.publicId}`, notes: `Settled by intermediary remittance ${remittance.publicId}`, originLoanId: loan.id, warnings: [], createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
            await createAuditLog(tx, { ...auditContext(ctx), entityType: "payment_intake", entityId: intake.publicId, action: "created", payload: { amount: serializeMoney(collection.amount), receivedAt: collection.borrowerPaidAt.toISOString(), originLoanPublicId: loan.publicId, intermediaryCollectionPublicId: collection.publicId, remittancePublicId: remittance.publicId } });
            const paymentProposal = await previewPaymentMatch(ctx, intake.publicId, { allocations: [{ borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, amount: serializeMoney(collection.amount) }] }, tx);
            if (paymentProposal.status !== "ready") throw new DomainError("REMITTANCE_PAYMENT_NOT_READY", "A collection payment requires review", 409, { collectionPublicId: collection.publicId, warnings: paymentProposal.warnings });
            await postPayment(ctx, intake.publicId, { proposalPublicId: paymentProposal.publicId }, tx);
            await tx.update(intermediaryCollections).set({ status: "settled", postedPaymentIntakeId: intake.id, settledAt: new Date(), updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(eq(intermediaryCollections.id, collection.id));
        }
        await tx.update(intermediaryRemittanceProposals).set({ status: "stale" }).where(and(eq(intermediaryRemittanceProposals.remittanceId, remittance.id), sql`${intermediaryRemittanceProposals.id} <> ${proposal.id}`));
        const posted = await tx.update(intermediaryRemittances).set({ status: "posted", postIdempotencyKey: postKey, postedByUserId: ctx.actorUserId, postedAt: new Date(), updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(eq(intermediaryRemittances.id, remittance.id)).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, { ...auditContext(ctx), entityType: "intermediary_remittance", entityId: posted.publicId, action: "posted", payload: { proposalPublicId: proposal.publicId, collectionPublicIds: selection.collections.map((row: typeof intermediaryCollections.$inferSelect) => row.publicId), amount: serializeMoney(posted.grossAmount) } });
        return presentRemittance(posted, selection.selected);
    });
    return result;
}

export async function manualApproveIntermediaryCollection(ctx: CommandContext, publicId: string, input: { reason: string; confirmed: boolean }) {
    if (!input.confirmed) throw new DomainError("MANUAL_APPROVAL_CONFIRMATION_REQUIRED", "Explicit confirmation is required", 400);
    const reason = input.reason?.trim();
    if (!reason) throw new DomainError("MANUAL_APPROVAL_REASON_REQUIRED", "Manual approval requires a reason", 400);
    if (!ctx.idempotencyKey?.trim()) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400);
    const actor = await actorFor(ctx);
    if (!actor || !canAccessTenantWideData({ role: actor.role ?? "viewer" })) throw new DomainError("TENANT_ADMIN_REQUIRED", "Tenant owner or manager permission is required", 403);
    return db.transaction(async (tx) => {
        const collection = await tx.query.intermediaryCollections.findFirst({ where: and(eq(intermediaryCollections.tenantId, ctx.tenantId), eq(intermediaryCollections.publicId, publicId)) });
        if (!collection) throw new DomainError("INTERMEDIARY_COLLECTION_NOT_FOUND", "Intermediary collection not found", 404);
        await tx.execute(sql`SELECT id FROM intermediary_collections WHERE id = ${collection.id} FOR UPDATE`);
        if (collection.status === "manual_approved") {
            if (collection.manualApprovalReason !== reason) throw new DomainError("MANUAL_APPROVAL_IDEMPOTENCY_CONFLICT", "Collection was manually approved with a different reason", 409);
            return presentCollection(collection);
        }
        if (collection.status !== "pending_remittance") throw new DomainError("MANUAL_APPROVAL_NOT_ALLOWED", "Only an unallocated pending collection can be manually approved", 409);
        const [borrower, loan] = await Promise.all([
            tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.id, collection.borrowerId)) }),
            tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, collection.loanId)) }),
        ]);
        if (!borrower || !loan) throw new DomainError("COLLECTION_TARGET_NOT_FOUND", "Collection borrower or loan no longer exists", 409);
        const intake = await tx.insert(paymentIntakes).values({ tenantId: ctx.tenantId, ownerUserId: collection.ownerUserId, source: ctx.actorSource === "mcp" ? "mcp" : "web", status: "draft", amount: serializeMoney(collection.amount), receivedAt: collection.borrowerPaidAt, payerName: borrower.name, bankReference: collection.bankReference, bankReferenceHash: collection.bankReferenceHash, idempotencyKey: `intermediary-manual:${collection.publicId}`, notes: `Manual intermediary approval: ${reason}`, originLoanId: loan.id, warnings: [], createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        const proposal = await previewPaymentMatch(ctx, intake.publicId, { allocations: [{ borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, amount: serializeMoney(collection.amount) }] }, tx);
        if (proposal.status !== "ready") throw new DomainError("MANUAL_APPROVAL_PAYMENT_NOT_READY", "Collection payment requires review", 409, { warnings: proposal.warnings });
        await postPayment(ctx, intake.publicId, { proposalPublicId: proposal.publicId }, tx);
        const approved = await tx.update(intermediaryCollections).set({ status: "manual_approved", manualApprovalReason: reason, postedPaymentIntakeId: intake.id, approvedByUserId: actor.id, settledAt: new Date(), updatedByUserId: actor.id, updatedAt: new Date() }).where(eq(intermediaryCollections.id, collection.id)).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, { ...auditContext(ctx), entityType: "intermediary_collection", entityId: approved.publicId, action: "manual_approved", payload: { reason, paymentIntakePublicId: intake.publicId, amount: serializeMoney(approved.amount), borrowerPaidAt: approved.borrowerPaidAt.toISOString() } });
        return presentCollection(approved);
    });
}

export async function reverseIntermediaryRemittance(ctx: CommandContext, publicId: string, input: { reason: string }) {
    const reason = input.reason?.trim();
    if (!reason) throw new DomainError("REVERSAL_REASON_REQUIRED", "Remittance reversal requires a reason", 400);
    const reversalKey = ctx.idempotencyKey?.trim();
    if (!reversalKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400);
    const actor = await actorFor(ctx);
    if (!actor || !canAccessTenantWideData({ role: actor.role ?? "viewer" })) throw new DomainError("TENANT_ADMIN_REQUIRED", "Tenant owner or manager permission is required", 403);
    return db.transaction(async (tx) => {
        const remittance = await tx.query.intermediaryRemittances.findFirst({ where: and(eq(intermediaryRemittances.tenantId, ctx.tenantId), eq(intermediaryRemittances.publicId, publicId)) });
        if (!remittance) throw new DomainError("INTERMEDIARY_REMITTANCE_NOT_FOUND", "Remittance not found", 404);
        await tx.execute(sql`SELECT id FROM intermediary_remittances WHERE id = ${remittance.id} FOR UPDATE`);
        if (remittance.status === "reversed") {
            if (remittance.reversalIdempotencyKey !== reversalKey || remittance.reversalReason !== reason) throw new DomainError("REMITTANCE_REVERSAL_IDEMPOTENCY_CONFLICT", "Remittance was reversed with a different key or reason", 409);
            return { ...presentRemittance(remittance, new Decimal(remittance.grossAmount)), reversalReason: remittance.reversalReason };
        }
        if (remittance.status !== "posted") throw new DomainError("REMITTANCE_NOT_POSTED", "Only a posted remittance can be reversed", 409);
        const selection = await remittanceSelection(tx, ctx.tenantId, remittance.id);
        const ordered = [...selection.collections].sort((a, b) => b.borrowerPaidAt.getTime() - a.borrowerPaidAt.getTime() || b.id - a.id);
        for (const collection of ordered) {
            if (collection.status !== "settled" || !collection.postedPaymentIntakeId) throw new DomainError("REMITTANCE_REVERSAL_BLOCKED", "Every remittance collection must still be settled", 409);
            const intake = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, collection.postedPaymentIntakeId)) });
            if (!intake) throw new DomainError("REMITTANCE_REVERSAL_BLOCKED", "A posted collection payment is missing", 409);
            await reversePayment(ctx, intake.publicId, { reason }, tx);
            await tx.update(intermediaryCollections).set({ status: "reversed", reversedAt: new Date(), updatedByUserId: actor.id, updatedAt: new Date() }).where(eq(intermediaryCollections.id, collection.id));
        }
        const reversed = await tx.update(intermediaryRemittances).set({ status: "reversed", reversalIdempotencyKey: reversalKey, reversalReason: reason, reversedByUserId: actor.id, reversedAt: new Date(), updatedByUserId: actor.id, updatedAt: new Date() }).where(eq(intermediaryRemittances.id, remittance.id)).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, { ...auditContext(ctx), entityType: "intermediary_remittance", entityId: reversed.publicId, action: "reversed", payload: { reason, collectionPublicIds: ordered.map((row) => row.publicId), amount: serializeMoney(reversed.grossAmount) } });
        return { ...presentRemittance(reversed), reversalReason: reversed.reversalReason };
    });
}
