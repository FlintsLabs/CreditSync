import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, count, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import {
    borrowerAliases,
    borrowers,
    files,
    fundLedgerEntries,
    loanFundingAllocations,
    loanInterestAccruals,
    loanSchedules,
    loans,
    paymentEvidence,
    paymentIntakes,
    paymentMatchAllocations,
    paymentMatchProposals,
    transactions,
    users,
} from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { canAccessTenantWideData } from "../lib/access";
import { invalidateTenantCache } from "../lib/cache";
import { computeLoanRollup } from "../lib/loan-rollup";
import { parseMoney, serializeMoney, sumMoney } from "../lib/money";
import {
    BUCKET_NAME,
    createSignedPutUrl,
    headStoredObject,
    toStorageReference,
    type SignedPutRequest,
    type StoredObjectHead,
} from "../lib/storage";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { normalizeBorrowerText } from "./borrower-service";
import { floatingInterestDue } from "./floating-interest-service";

type Executor = any;
type IntakeRow = typeof paymentIntakes.$inferSelect;
type ProposalRow = typeof paymentMatchProposals.$inferSelect;
type AllocationRow = typeof paymentMatchAllocations.$inferSelect;

export interface EvidenceStorageGateway {
    preparePut(request: SignedPutRequest): Promise<{ uploadUrl: string; expiresAt: Date; requiredHeaders?: Record<string, string> }>;
    head(key: string, bucket?: string): Promise<StoredObjectHead>;
}

const defaultEvidenceGateway: EvidenceStorageGateway = {
    preparePut: createSignedPutUrl,
    head: headStoredObject,
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const allowedEvidenceTypes = new Set(["image/jpeg", "image/png", "application/pdf"]);
const semanticDuplicateWindowMs = 5 * 60 * 1000;

function hash(value: string) {
    return createHash("sha256").update(value).digest("hex");
}

function requirePublicId(value: string, field = "id") {
    if (!uuidPattern.test(value)) {
        throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400, { field });
    }
}

function paymentMoney(value: string) {
    try {
        return parseMoney(value);
    } catch {
        throw new DomainError("INVALID_PAYMENT_AMOUNT", "Payment amounts must be non-negative strings with exactly two decimals", 400);
    }
}

export function normalizeBankReference(value: string): string {
    return value.normalize("NFKC").toLocaleLowerCase("und").replace(/[\p{P}\p{S}\s]+/gu, "");
}

function auditContext(ctx: CommandContext) {
    return {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorSource: ctx.actorSource,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
    };
}

async function actorFor(ctx: CommandContext, executor: Executor = db) {
    if (ctx.actorUserId === null) return null;
    const actor = await executor.query.users.findFirst({
        where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)),
    });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

async function accessibleOriginLoan(ctx: CommandContext, publicId?: string | null) {
    if (!publicId) return null;
    requirePublicId(publicId, "originLoanPublicId");
    const actor = await actorFor(ctx);
    const conditions = [eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, publicId)];
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        conditions.push(eq(loans.ownerUserId, actor.id));
    }
    const loan = await db.query.loans.findFirst({ where: and(...conditions) });
    if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    return loan;
}

async function accessibleIntake(ctx: CommandContext, publicId: string, executor: Executor = db): Promise<IntakeRow> {
    requirePublicId(publicId, "paymentIntakeId");
    const actor = await actorFor(ctx, executor);
    const row = await executor.query.paymentIntakes.findFirst({
        where: and(eq(paymentIntakes.publicId, publicId), eq(paymentIntakes.tenantId, ctx.tenantId)),
    });
    if (!row || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && row.ownerUserId !== actor.id)) {
        throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    }
    return row;
}

function presentIntake(row: IntakeRow) {
    return {
        id: row.publicId,
        publicId: row.publicId,
        source: row.source,
        status: row.status,
        amount: serializeMoney(row.amount),
        receivedAt: row.receivedAt,
        payerName: row.payerName,
        bankReference: row.bankReference,
        warnings: row.warnings ?? [],
        notes: row.notes,
        postedAt: row.postedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function duplicateResult(row: IntakeRow, reason: string) {
    return { id: row.publicId, publicId: row.publicId, status: row.status, duplicate: true as const, duplicateReason: reason, warnings: [] };
}

async function findHardDuplicate(ctx: CommandContext, input: {
    idempotencyKey?: string | null;
    bankReferenceHash?: string | null;
    qrPayloadHash?: string | null;
}, executor: Executor = db) {
    const rows = await executor.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, ctx.tenantId));
    if (input.idempotencyKey) {
        const row = rows.find((candidate: IntakeRow) => candidate.idempotencyKey === input.idempotencyKey);
        if (row) return { row, reason: "idempotency_key" };
    }
    if (input.bankReferenceHash) {
        const row = rows.find((candidate: IntakeRow) => candidate.bankReferenceHash === input.bankReferenceHash);
        if (row) return { row, reason: "bank_reference" };
    }
    if (input.qrPayloadHash) {
        const row = rows.find((candidate: IntakeRow) => candidate.qrPayloadHash === input.qrPayloadHash);
        if (row) return { row, reason: "qr_payload" };
    }
    return null;
}

export interface CreatePaymentIntakeInput {
    amount: string;
    receivedAt: string;
    payerName?: string | null;
    bankReference?: string | null;
    qrPayload?: string | null;
    notes?: string | null;
    originLoanPublicId?: string | null;
}

export async function createPaymentIntake(ctx: CommandContext, input: CreatePaymentIntakeInput) {
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (ctx.idempotencyKey !== undefined && !idempotencyKey) {
        throw new DomainError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must not be blank", 400);
    }
    const amount = paymentMoney(input.amount);
    if (amount.isZero()) throw new DomainError("INVALID_PAYMENT_AMOUNT", "Payment amount must be greater than zero", 400);
    const receivedAt = new Date(input.receivedAt);
    if (Number.isNaN(receivedAt.getTime())) throw new DomainError("INVALID_RECEIVED_AT", "receivedAt must be an ISO date-time", 400);
    await actorFor(ctx);
    const originLoan = await accessibleOriginLoan(ctx, input.originLoanPublicId);
    const normalizedReference = input.bankReference ? normalizeBankReference(input.bankReference) : "";
    const bankReferenceHash = normalizedReference ? hash(normalizedReference) : null;
    const qrPayloadHash = input.qrPayload ? hash(input.qrPayload) : null;
    const duplicate = await findHardDuplicate(ctx, {
        idempotencyKey,
        bankReferenceHash,
        qrPayloadHash,
    });
    if (duplicate) return duplicateResult(duplicate.row, duplicate.reason);

    const normalizedPayer = normalizeBorrowerText(input.payerName ?? "");
    const possibleDuplicates = (await db.select().from(paymentIntakes).where(and(
        eq(paymentIntakes.tenantId, ctx.tenantId),
        eq(paymentIntakes.amount, serializeMoney(amount)),
    ))).filter((candidate) => candidate.publicId && candidate.payerName
        && normalizeBorrowerText(candidate.payerName) === normalizedPayer
        && Math.abs(candidate.receivedAt.getTime() - receivedAt.getTime()) <= semanticDuplicateWindowMs);
    const warnings = possibleDuplicates.length ? [{
        code: "POSSIBLE_SEMANTIC_DUPLICATE",
        intakePublicIds: possibleDuplicates.map((candidate) => candidate.publicId),
    }] : [];

    try {
        const row = await db.transaction(async (tx) => {
            const created = await tx.insert(paymentIntakes).values({
                tenantId: ctx.tenantId,
                ownerUserId: ctx.actorUserId,
                source: ctx.actorSource === "mcp" ? "mcp" : "web",
                status: warnings.length ? "needs_review" : "draft",
                amount: serializeMoney(amount),
                receivedAt,
                payerName: input.payerName?.trim() || null,
                bankReference: input.bankReference?.trim() || null,
                bankReferenceHash,
                qrPayloadHash,
                originLoanId: originLoan?.id ?? null,
                warnings,
                idempotencyKey: idempotencyKey ?? null,
                notes: input.notes ?? null,
                createdByUserId: ctx.actorUserId,
                updatedByUserId: ctx.actorUserId,
            }).returning().then((rows) => rows[0]!);
            await createAuditLog(tx, {
                ...auditContext(ctx), entityType: "payment_intake", entityId: created.publicId,
                action: "created",
                payload: {
                    amount: serializeMoney(amount),
                    receivedAt: receivedAt.toISOString(),
                    originLoanPublicId: originLoan?.publicId ?? null,
                    warningCodes: warnings.map((item) => item.code),
                },
            });
            return created;
        });
        return {
            ...presentIntake(row),
            originLoanPublicId: originLoan?.publicId ?? null,
            duplicate: false as const,
            duplicateReason: null,
            warnings,
        };
    } catch (error) {
        if ((error as { code?: string }).code === "23505") {
            const raced = await findHardDuplicate(ctx, {
                idempotencyKey,
                bankReferenceHash,
                qrPayloadHash,
            });
            if (raced) return duplicateResult(raced.row, raced.reason);
        }
        throw error;
    }
}

export async function listPaymentIntakes(ctx: CommandContext, input: { status?: string } = {}) {
    const actor = await actorFor(ctx);
    const conditions = [eq(paymentIntakes.tenantId, ctx.tenantId)];
    if (input.status) conditions.push(eq(paymentIntakes.status, input.status));
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) conditions.push(eq(paymentIntakes.ownerUserId, actor.id));
    const rows = await db.select().from(paymentIntakes).where(and(...conditions)).orderBy(desc(paymentIntakes.receivedAt));
    return rows.map(presentIntake);
}

const paymentIntakeStatuses = new Set(["draft", "needs_review", "ready", "posted", "reversed", "duplicate"]);
const businessDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export interface PaymentIntakeListInput {
    search?: string;
    status?: string;
    from?: string;
    to?: string;
    page?: string;
    pageSize?: string;
}

function invalidPaymentListQuery(field: string) {
    throw new DomainError("INVALID_PAYMENT_LIST_QUERY", "Invalid payment list query", 400, { field });
}

function parsePositiveInteger(value: string | undefined, fallback: number, field: string, maximum?: number) {
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value)) invalidPaymentListQuery(field);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || (maximum !== undefined && parsed > maximum)) invalidPaymentListQuery(field);
    return parsed;
}

function parseBusinessDate(value: string | undefined, field: string) {
    if (value === undefined) return undefined;
    if (!businessDatePattern.test(value)) invalidPaymentListQuery(field);
    const [year, month, day] = value.split("-").map(Number);
    const calendarDate = new Date(Date.UTC(year!, month! - 1, day!));
    if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month! - 1 || calendarDate.getUTCDate() !== day) {
        invalidPaymentListQuery(field);
    }
    return new Date(`${value}T00:00:00+07:00`);
}

export async function listPaymentIntakePage(ctx: CommandContext, input: PaymentIntakeListInput = {}) {
    const actor = await actorFor(ctx);
    const page = parsePositiveInteger(input.page, 1, "page");
    const pageSize = parsePositiveInteger(input.pageSize, 25, "pageSize", 100);
    const search = input.search?.trim() ?? "";
    if (search.length > 200) invalidPaymentListQuery("search");
    if (input.status && !paymentIntakeStatuses.has(input.status)) invalidPaymentListQuery("status");
    const from = parseBusinessDate(input.from, "from");
    const to = parseBusinessDate(input.to, "to");
    if (from && to && from > to) invalidPaymentListQuery("dateRange");

    const conditions = [eq(paymentIntakes.tenantId, ctx.tenantId)];
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) conditions.push(eq(paymentIntakes.ownerUserId, actor.id));
    if (input.status) conditions.push(eq(paymentIntakes.status, input.status));
    if (search) {
        const escaped = search.replace(/[\\%_]/g, "\\$&");
        conditions.push(sql`${paymentIntakes.payerName} ILIKE ${`%${escaped}%`} ESCAPE '\\'`);
    }
    if (from) conditions.push(gte(paymentIntakes.receivedAt, from));
    if (to) conditions.push(lt(paymentIntakes.receivedAt, new Date(to.getTime() + 24 * 60 * 60 * 1000)));

    const where = and(...conditions);
    const [totalRow, rows] = await Promise.all([
        db.select({ value: count() }).from(paymentIntakes).where(where).then((result) => result[0]!),
        db.select().from(paymentIntakes).where(where)
            .orderBy(desc(paymentIntakes.receivedAt), desc(paymentIntakes.id))
            .limit(pageSize).offset((page - 1) * pageSize),
    ]);
    const total = totalRow.value;
    return {
        items: rows.map(presentIntake),
        page,
        pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    };
}

export async function listLoanPaymentIntakes(ctx: CommandContext, loanPublicId: string) {
    const loan = await accessibleOriginLoan(ctx, loanPublicId);
    if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    const actor = await actorFor(ctx);
    const intakeConditions = [eq(paymentIntakes.tenantId, ctx.tenantId)];
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        intakeConditions.push(eq(paymentIntakes.ownerUserId, actor.id));
    }
    const intakeRows = await db.select().from(paymentIntakes).where(and(...intakeConditions));
    if (!intakeRows.length) return [];

    const intakeIds = intakeRows.map((row) => row.id);
    const [transactionRows, proposalRows] = await Promise.all([
        db.select().from(transactions).where(and(
            eq(transactions.tenantId, ctx.tenantId),
            eq(transactions.loanId, loan.id),
            inArray(transactions.paymentIntakeId, intakeIds),
        )),
        db.select().from(paymentMatchProposals).where(and(
            eq(paymentMatchProposals.tenantId, ctx.tenantId),
            inArray(paymentMatchProposals.paymentIntakeId, intakeIds),
        )),
    ]);
    const latestProposalByIntake = new Map<number, ProposalRow>();
    for (const proposal of proposalRows) {
        const current = latestProposalByIntake.get(proposal.paymentIntakeId);
        if (!current || proposal.version > current.version) latestProposalByIntake.set(proposal.paymentIntakeId, proposal);
    }
    const latestProposalIds = Array.from(latestProposalByIntake.values(), (proposal) => proposal.id);
    const allocationRows = latestProposalIds.length
        ? await db.select().from(paymentMatchAllocations).where(and(
            eq(paymentMatchAllocations.tenantId, ctx.tenantId),
            inArray(paymentMatchAllocations.proposalId, latestProposalIds),
        ))
        : [];
    const allocationByProposal = new Map<number, AllocationRow[]>();
    for (const allocation of allocationRows) {
        if (allocation.loanId !== loan.id) continue;
        allocationByProposal.set(allocation.proposalId, [...(allocationByProposal.get(allocation.proposalId) ?? []), allocation]);
    }
    const transactionsByIntake = new Map<number, Array<typeof transactions.$inferSelect>>();
    for (const transaction of transactionRows) {
        if (transaction.paymentIntakeId === null) continue;
        transactionsByIntake.set(transaction.paymentIntakeId, [...(transactionsByIntake.get(transaction.paymentIntakeId) ?? []), transaction]);
    }

    return intakeRows
        .filter((intake) => intake.originLoanId === loan.id
            || transactionsByIntake.has(intake.id)
            || allocationByProposal.has(latestProposalByIntake.get(intake.id)?.id ?? -1))
        .sort((left, right) => right.receivedAt.getTime() - left.receivedAt.getTime())
        .map((intake) => {
            const allocation = allocationByProposal.get(latestProposalByIntake.get(intake.id)?.id ?? -1) ?? [];
            const postedTransactions = transactionsByIntake.get(intake.id) ?? [];
            const sumComponent = (field: "principalComponent" | "interestComponent" | "feeComponent" | "penaltyComponent") =>
                postedTransactions.reduce((total, transaction) => total.plus(transaction[field] ?? "0"), new Decimal(0));
            return {
                ...presentIntake(intake),
                originLoanPublicId: intake.originLoanId === loan.id ? loan.publicId : null,
                latestAllocation: allocation.length ? {
                    amount: allocation.reduce((total, row) => total.plus(row.amount), new Decimal(0)).toFixed(2),
                    proposalPublicId: latestProposalByIntake.get(intake.id)?.publicId ?? null,
                } : null,
                postedComponents: intake.status === "posted" ? {
                    principal: serializeMoney(sumComponent("principalComponent")),
                    interest: serializeMoney(sumComponent("interestComponent")),
                    fee: serializeMoney(sumComponent("feeComponent")),
                    penalty: serializeMoney(sumComponent("penaltyComponent")),
                } : null,
            };
        });
}

export async function listPaymentReviewQueue(ctx: CommandContext) {
    return listPaymentIntakes(ctx, { status: "needs_review" });
}

export async function getPaymentIntake(ctx: CommandContext, publicId: string) {
    const row = await accessibleIntake(ctx, publicId);
    const [evidenceRows, proposals] = await Promise.all([
        db.select().from(paymentEvidence).where(and(eq(paymentEvidence.tenantId, ctx.tenantId), eq(paymentEvidence.paymentIntakeId, row.id))),
        db.select().from(paymentMatchProposals).where(and(eq(paymentMatchProposals.tenantId, ctx.tenantId), eq(paymentMatchProposals.paymentIntakeId, row.id))).orderBy(desc(paymentMatchProposals.version)),
    ]);
    const evidenceFileIds = evidenceRows.flatMap((item) => item.fileId ? [item.fileId] : []);
    const evidenceFiles = evidenceFileIds.length ? await db.select().from(files).where(and(
        eq(files.tenantId, ctx.tenantId), inArray(files.id, evidenceFileIds),
    )) : [];
    const evidenceFileById = new Map(evidenceFiles.map((file) => [file.id, file]));
    const latest = proposals[0];
    let latestAllocations: Array<AllocationRow & { borrowerPublicId: string; loanPublicId: string; schedulePublicId: string | null }> = [];
    if (latest) {
        const allocationRows = await db.select().from(paymentMatchAllocations).where(and(
            eq(paymentMatchAllocations.tenantId, ctx.tenantId), eq(paymentMatchAllocations.proposalId, latest.id),
        )).orderBy(paymentMatchAllocations.allocationOrder);
        const [borrowerRows, loanRows, scheduleRows] = await Promise.all([
            allocationRows.length ? db.select().from(borrowers).where(and(eq(borrowers.tenantId, ctx.tenantId), inArray(borrowers.id, allocationRows.map((item) => item.borrowerId)))) : [],
            allocationRows.length ? db.select().from(loans).where(and(eq(loans.tenantId, ctx.tenantId), inArray(loans.id, allocationRows.map((item) => item.loanId)))) : [],
            allocationRows.some((item) => item.scheduleId !== null) ? db.select().from(loanSchedules).where(and(
                eq(loanSchedules.tenantId, ctx.tenantId),
                inArray(loanSchedules.id, allocationRows.map((item) => item.scheduleId).filter((id): id is number => id !== null)),
            )) : [],
        ]);
        latestAllocations = allocationRows.map((item) => ({
            ...item,
            borrowerPublicId: borrowerRows.find((candidate) => candidate.id === item.borrowerId)!.publicId,
            loanPublicId: loanRows.find((candidate) => candidate.id === item.loanId)!.publicId,
            schedulePublicId: scheduleRows.find((candidate) => candidate.id === item.scheduleId)?.publicId ?? null,
        }));
    }
    return {
        ...presentIntake(row),
        evidence: evidenceRows.map((item) => ({
            id: item.publicId,
            publicId: item.publicId,
            status: item.status,
            mimeType: item.mimeType,
            size: item.declaredSize,
            sha256: item.evidenceHash,
            filePublicId: item.fileId ? evidenceFileById.get(item.fileId)?.publicId ?? null : null,
        })),
        latestProposal: latest ? presentProposal(latest, latestAllocations) : null,
    };
}

export async function reviewPaymentIntake(
    ctx: CommandContext,
    publicId: string,
    input: { status: "draft" | "needs_review"; notes?: string | null },
) {
    const existing = await accessibleIntake(ctx, publicId);
    if (["posted", "reversed", "duplicate"].includes(existing.status)) {
        throw new DomainError("PAYMENT_INTAKE_IMMUTABLE", "Posted, reversed, or duplicate intake cannot be reviewed", 409);
    }
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM payment_intakes WHERE id = ${existing.id} FOR UPDATE`);
        const locked = await tx.query.paymentIntakes.findFirst({ where: and(
            eq(paymentIntakes.id, existing.id), eq(paymentIntakes.tenantId, ctx.tenantId),
        ) });
        if (!locked || ["posted", "reversed", "duplicate"].includes(locked.status)) {
            throw new DomainError("PAYMENT_INTAKE_IMMUTABLE", "Posted, reversed, or duplicate intake cannot be reviewed", 409);
        }
        const row = await tx.update(paymentIntakes).set({
            status: input.status,
            ...(input.notes === undefined ? {} : { notes: input.notes }),
            updatedByUserId: ctx.actorUserId,
            updatedAt: new Date(),
        }).where(and(eq(paymentIntakes.id, existing.id), eq(paymentIntakes.tenantId, ctx.tenantId)))
            .returning().then((rows) => rows[0]!);
        await tx.update(paymentMatchProposals).set({
            status: "stale",
            updatedByUserId: ctx.actorUserId,
            updatedAt: new Date(),
        }).where(and(
            eq(paymentMatchProposals.tenantId, ctx.tenantId),
            eq(paymentMatchProposals.paymentIntakeId, existing.id),
            inArray(paymentMatchProposals.status, ["draft", "ready", "needs_review"]),
        ));
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "payment_intake", entityId: row.publicId, action: "reviewed",
            payload: { beforeStatus: locked.status, afterStatus: row.status },
        });
        return presentIntake(row);
    });
}

export interface PrepareEvidenceInput { mimeType: string; size: number; sha256: string; evidenceType?: "slip" | "qr"; url?: string }

function validateEvidenceInput(input: PrepareEvidenceInput) {
    const maxBytes = Math.max(1, Number(process.env.EVIDENCE_MAX_BYTES ?? 20 * 1024 * 1024));
    if (input.url !== undefined || !allowedEvidenceTypes.has(input.mimeType) || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > maxBytes || !sha256Pattern.test(input.sha256)) {
        throw new DomainError("INVALID_EVIDENCE", "Evidence must be JPEG, PNG, or PDF with a valid size and SHA-256", 400);
    }
}

async function lockMutableEvidenceIntake(tx: Executor, ctx: CommandContext, intakeId: number) {
    await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id = ${intakeId} FOR UPDATE`);
    const current = await tx.query.paymentIntakes.findFirst({ where: and(
        eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, intakeId),
    ) });
    if (!current) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    if (["posted", "reversed", "duplicate"].includes(current.status)) {
        throw new DomainError("PAYMENT_INTAKE_IMMUTABLE", "Evidence cannot be added to this intake", 409);
    }
    return current;
}

function evidenceIntentExpired(evidence: typeof paymentEvidence.$inferSelect, now = new Date()) {
    if (evidence.uploadExpiresAt) return evidence.uploadExpiresAt.getTime() <= now.getTime();
    const preparationGraceMs = Math.max(60, Math.min(900, Number(process.env.EVIDENCE_UPLOAD_TTL_SECONDS ?? 300))) * 1000;
    return evidence.createdAt.getTime() + preparationGraceMs <= now.getTime();
}

export async function preparePaymentEvidence(
    ctx: CommandContext,
    intakePublicId: string,
    input: PrepareEvidenceInput,
    gateway: EvidenceStorageGateway = defaultEvidenceGateway,
): Promise<any> {
    validateEvidenceInput(input);
    const intake = await accessibleIntake(ctx, intakePublicId);
    if (["posted", "reversed", "duplicate"].includes(intake.status)) throw new DomainError("PAYMENT_INTAKE_IMMUTABLE", "Evidence cannot be added to this intake", 409);
    const sha256 = input.sha256.toLocaleLowerCase();
    const existing = await db.query.paymentEvidence.findFirst({
        where: and(eq(paymentEvidence.tenantId, ctx.tenantId), eq(paymentEvidence.evidenceHash, sha256)),
    });
    if (existing && existing.paymentIntakeId === intake.id) {
        if (existing.status === "ready") {
            const readyFile = existing.fileId ? await db.query.files.findFirst({ where: and(eq(files.id, existing.fileId), eq(files.tenantId, ctx.tenantId)) }) : null;
            return { id: existing.publicId, publicId: existing.publicId, filePublicId: readyFile?.publicId ?? null, status: "ready" as const };
        }
        if (existing.mimeType !== input.mimeType || existing.declaredSize !== input.size || !existing.fileId) {
            throw new DomainError("EVIDENCE_HASH_CONFLICT", "Existing evidence intent has different metadata", 409);
        }
        if (evidenceIntentExpired(existing)) {
            await db.transaction(async (tx) => {
                await lockMutableEvidenceIntake(tx, ctx, intake.id);
                const removed = await tx.delete(paymentEvidence).where(and(
                    eq(paymentEvidence.id, existing.id), eq(paymentEvidence.status, "pending"),
                )).returning();
                if (removed.length && existing.fileId) {
                    await tx.delete(files).where(and(eq(files.id, existing.fileId), eq(files.tenantId, ctx.tenantId)));
                }
            });
            return preparePaymentEvidence(ctx, intakePublicId, input, gateway);
        }
        const existingFile = await db.query.files.findFirst({ where: and(eq(files.id, existing.fileId), eq(files.tenantId, ctx.tenantId)) });
        if (!existingFile) throw new DomainError("PAYMENT_EVIDENCE_NOT_FOUND", "Evidence file record not found", 404);
        const existingMetadata = { tenant: ctx.tenantId, intake: intake.publicId };
        const resigned = await db.transaction(async (tx) => {
            await lockMutableEvidenceIntake(tx, ctx, intake.id);
            const signed = await gateway.preparePut({
                bucket: existingFile.bucket,
                key: existingFile.key,
                contentType: input.mimeType,
                contentLength: input.size,
                checksumSha256: sha256,
                metadata: existingMetadata,
            });
            await tx.update(paymentEvidence).set({ updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(
                eq(paymentEvidence.id, existing.id), eq(paymentEvidence.status, "pending"),
            ));
            await tx.update(paymentEvidence).set({ uploadExpiresAt: signed.expiresAt }).where(and(
                eq(paymentEvidence.id, existing.id), eq(paymentEvidence.status, "pending"),
            ));
            return signed;
        });
        return {
            id: existing.publicId,
            publicId: existing.publicId,
            filePublicId: existingFile.publicId,
            objectKey: existingFile.key,
            uploadUrl: resigned.uploadUrl,
            expiresAt: resigned.expiresAt,
            requiredHeaders: resigned.requiredHeaders ?? {
                "content-type": input.mimeType,
                "x-amz-checksum-sha256": Buffer.from(sha256, "hex").toString("base64"),
                "x-amz-meta-tenant": ctx.tenantId,
                "x-amz-meta-intake": intake.publicId,
            },
        };
    }
    if (existing && existing.paymentIntakeId !== intake.id) {
        if (existing.status !== "ready") {
            if (evidenceIntentExpired(existing)) {
                await db.transaction(async (tx) => {
                    await tx.execute(sql`SELECT id FROM payment_evidence WHERE tenant_id = ${ctx.tenantId} AND id = ${existing.id} FOR UPDATE`);
                    const current = await tx.query.paymentEvidence.findFirst({ where: and(
                        eq(paymentEvidence.tenantId, ctx.tenantId), eq(paymentEvidence.id, existing.id),
                    ) });
                    if (!current || current.status !== "pending" || !evidenceIntentExpired(current)) return false;
                    await tx.delete(paymentEvidence).where(and(
                        eq(paymentEvidence.id, current.id), eq(paymentEvidence.status, "pending"),
                    ));
                    if (current.fileId) {
                        await tx.delete(files).where(and(eq(files.id, current.fileId), eq(files.tenantId, ctx.tenantId)));
                    }
                    return true;
                });
                return preparePaymentEvidence(ctx, intakePublicId, input, gateway);
            }
            throw new DomainError("EVIDENCE_HASH_PENDING", "The evidence checksum is already reserved by an upload in progress", 409);
        }
        const original = await db.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, existing.paymentIntakeId)) });
        if (original) {
            await db.transaction(async (tx) => {
                await lockMutableEvidenceIntake(tx, ctx, intake.id);
                await tx.update(paymentIntakes).set({
                    status: "duplicate",
                    duplicateOfIntakeId: original.id,
                    updatedByUserId: ctx.actorUserId,
                    updatedAt: new Date(),
                }).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, intake.id)));
                await createAuditLog(tx, {
                    ...auditContext(ctx), entityType: "payment_intake", entityId: intake.publicId,
                    action: "duplicate_detected",
                    payload: { duplicateOfPublicId: original.publicId, reason: "evidence_sha256" },
                });
            });
            return { ...duplicateResult(original, "evidence_sha256"), intakePublicId: original.publicId };
        }
    }
    const key = `payment-evidence/${ctx.tenantId}/${intake.publicId}/${crypto.randomUUID()}`;
    const metadata = { tenant: ctx.tenantId, intake: intake.publicId };
    let created: { file: typeof files.$inferSelect; evidence: typeof paymentEvidence.$inferSelect };
    try {
        created = await db.transaction(async (tx) => {
        await lockMutableEvidenceIntake(tx, ctx, intake.id);
        const file = await tx.insert(files).values({
            tenantId: ctx.tenantId,
            ownerUserId: ctx.actorUserId,
            bucket: BUCKET_NAME,
            key,
            mimeType: input.mimeType,
            size: input.size,
            url: toStorageReference({ provider: "s3", bucket: BUCKET_NAME, key }),
        }).returning().then((rows: Array<typeof files.$inferSelect>) => rows[0]!);
        const evidence = await tx.insert(paymentEvidence).values({
            tenantId: ctx.tenantId,
            paymentIntakeId: intake.id,
            fileId: file.id,
            evidenceType: input.evidenceType ?? "slip",
            status: "pending",
            evidenceHash: sha256,
            mimeType: input.mimeType,
            declaredSize: input.size,
            createdByUserId: ctx.actorUserId,
            updatedByUserId: ctx.actorUserId,
        }).returning().then((rows: Array<typeof paymentEvidence.$inferSelect>) => rows[0]!);
        return { file, evidence };
        });
    } catch (error) {
        const databaseError = error as { code?: string; cause?: { code?: string } };
        if (databaseError.code === "23505" || databaseError.cause?.code === "23505") {
            throw new DomainError("EVIDENCE_HASH_CONFLICT", "The evidence checksum was reserved concurrently; retry the request", 409);
        }
        throw error;
    }
    let signed: Awaited<ReturnType<EvidenceStorageGateway["preparePut"]>>;
    try {
        signed = await gateway.preparePut({
            bucket: BUCKET_NAME,
            key,
            contentType: input.mimeType,
            contentLength: input.size,
            checksumSha256: sha256,
            metadata,
        });
        await db.transaction(async (tx) => {
            await lockMutableEvidenceIntake(tx, ctx, intake.id);
            await tx.execute(sql`SELECT id FROM payment_evidence WHERE tenant_id = ${ctx.tenantId} AND id = ${created.evidence.id} FOR UPDATE`);
            const updated = await tx.update(paymentEvidence).set({
                uploadExpiresAt: signed.expiresAt,
                updatedByUserId: ctx.actorUserId,
                updatedAt: new Date(),
            }).where(and(eq(paymentEvidence.id, created.evidence.id), eq(paymentEvidence.status, "pending"))).returning();
            if (!updated.length) throw new DomainError("EVIDENCE_PREPARE_CONFLICT", "Evidence intent can no longer be signed", 409);
        });
    } catch (error) {
        await db.transaction(async (tx) => {
            await tx.delete(paymentEvidence).where(and(
                eq(paymentEvidence.id, created.evidence.id), eq(paymentEvidence.status, "pending"),
            ));
            await tx.delete(files).where(and(eq(files.id, created.file.id), eq(files.tenantId, ctx.tenantId)));
        });
        throw error;
    }
    return {
        id: created.evidence.publicId,
        publicId: created.evidence.publicId,
        filePublicId: created.file.publicId,
        objectKey: key,
        uploadUrl: signed.uploadUrl,
        expiresAt: signed.expiresAt,
        requiredHeaders: signed.requiredHeaders ?? {
            "content-type": input.mimeType,
            "x-amz-checksum-sha256": Buffer.from(sha256, "hex").toString("base64"),
            "x-amz-meta-tenant": ctx.tenantId,
            "x-amz-meta-intake": intake.publicId,
        },
    };
}

export async function finalizePaymentEvidence(
    ctx: CommandContext,
    intakePublicId: string,
    evidencePublicId: string,
    gateway: EvidenceStorageGateway = defaultEvidenceGateway,
) {
    const intake = await accessibleIntake(ctx, intakePublicId);
    requirePublicId(evidencePublicId, "evidenceId");
    const evidence = await db.query.paymentEvidence.findFirst({
        where: and(eq(paymentEvidence.publicId, evidencePublicId), eq(paymentEvidence.tenantId, ctx.tenantId), eq(paymentEvidence.paymentIntakeId, intake.id)),
    });
    if (!evidence) throw new DomainError("PAYMENT_EVIDENCE_NOT_FOUND", "Payment evidence not found", 404);
    if (evidence.status === "ready") {
        const file = evidence.fileId ? await db.query.files.findFirst({ where: and(eq(files.id, evidence.fileId), eq(files.tenantId, ctx.tenantId)) }) : null;
        return { id: evidence.publicId, publicId: evidence.publicId, status: evidence.status, sha256: evidence.evidenceHash, filePublicId: file?.publicId ?? null };
    }
    const file = evidence.fileId ? await db.query.files.findFirst({ where: and(eq(files.id, evidence.fileId), eq(files.tenantId, ctx.tenantId)) }) : null;
    if (!file) throw new DomainError("PAYMENT_EVIDENCE_NOT_FOUND", "Evidence file record not found", 404);
    const head = await gateway.head(file.key, file.bucket);
    const valid = head.exists
        && head.contentType === evidence.mimeType
        && head.contentLength === evidence.declaredSize
        && head.checksumSha256?.toLocaleLowerCase() === evidence.evidenceHash?.toLocaleLowerCase()
        && head.metadata.tenant === ctx.tenantId
        && head.metadata.intake === intake.publicId;
    if (!valid) throw new DomainError("EVIDENCE_METADATA_MISMATCH", "Stored evidence metadata, size, type, ownership, or checksum does not match", 409);
    return db.transaction(async (tx) => {
        await lockMutableEvidenceIntake(tx, ctx, intake.id);
        await tx.execute(sql`SELECT id FROM payment_evidence WHERE tenant_id = ${ctx.tenantId} AND id = ${evidence.id} FOR UPDATE`);
        const current = await tx.query.paymentEvidence.findFirst({ where: and(
            eq(paymentEvidence.id, evidence.id), eq(paymentEvidence.tenantId, ctx.tenantId), eq(paymentEvidence.paymentIntakeId, intake.id),
        ) });
        if (!current) throw new DomainError("PAYMENT_EVIDENCE_NOT_FOUND", "Payment evidence not found", 404);
        if (current.status === "ready") {
            return { id: current.publicId, publicId: current.publicId, status: current.status, sha256: current.evidenceHash, filePublicId: file.publicId };
        }
        if (evidenceIntentExpired(current)) throw new DomainError("EVIDENCE_UPLOAD_EXPIRED", "Evidence upload intent has expired", 409);
        const stillValid = head.exists
            && head.contentType === current.mimeType
            && head.contentLength === current.declaredSize
            && head.checksumSha256?.toLocaleLowerCase() === current.evidenceHash?.toLocaleLowerCase()
            && head.metadata.tenant === ctx.tenantId
            && head.metadata.intake === intake.publicId;
        if (!stillValid) throw new DomainError("EVIDENCE_METADATA_MISMATCH", "Stored evidence metadata, size, type, ownership, or checksum does not match", 409);
        const updated = await tx.update(paymentEvidence).set({
            status: "ready", finalizedAt: new Date(), updatedByUserId: ctx.actorUserId, updatedAt: new Date(),
        }).where(and(eq(paymentEvidence.id, current.id), eq(paymentEvidence.status, "pending")))
            .returning().then((rows) => rows[0]);
        if (!updated) {
            throw new DomainError("EVIDENCE_FINALIZE_CONFLICT", "Evidence can no longer be finalized", 409);
        }
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "payment_evidence", entityId: updated.publicId, action: "finalized",
            payload: { intakePublicId: intake.publicId, mimeType: updated.mimeType, size: updated.declaredSize, sha256: updated.evidenceHash },
        });
        return { id: updated.publicId, publicId: updated.publicId, status: updated.status, sha256: updated.evidenceHash, filePublicId: file.publicId };
    });
}

export interface ExplicitPaymentAllocation {
    borrowerPublicId: string;
    loanPublicId: string;
    schedulePublicId?: string;
    amount: string;
}

interface ExpandedAllocation {
    borrowerId: number;
    borrowerPublicId: string;
    loanId: number;
    loanPublicId: string;
    scheduleId: number | null;
    schedulePublicId: string | null;
    amount: string;
    matchReason: string;
}

function presentProposal(row: ProposalRow, allocations: Array<AllocationRow & {
    borrowerPublicId?: string;
    loanPublicId?: string;
    schedulePublicId?: string | null;
}>, totalAllocated?: string) {
    return {
        id: row.publicId,
        publicId: row.publicId,
        version: row.version,
        status: row.status,
        warnings: (row.warnings ?? []) as unknown[],
        totalAllocated: totalAllocated ?? serializeMoney(allocations.reduce((sum, item) => sum.plus(item.amount), new Decimal(0))),
        expiresAt: row.expiresAt,
        allocations: allocations.map((item) => ({
            id: item.publicId,
            publicId: item.publicId,
            borrowerPublicId: item.borrowerPublicId,
            loanPublicId: item.loanPublicId,
            schedulePublicId: item.schedulePublicId,
            amount: serializeMoney(item.amount),
            matchReason: item.matchReason,
        })),
    };
}

async function stateHash(executor: Executor, intake: IntakeRow, allocations: Array<{ loanId: number; scheduleId: number | null; amount: string }>) {
    const scheduleIds = [...new Set(allocations.map((item) => item.scheduleId).filter((id): id is number => id !== null))].sort((a, b) => a - b);
    const loanIds = [...new Set(allocations.map((item) => item.loanId))].sort((a, b) => a - b);
    const scheduleRows = scheduleIds.length ? await executor.select().from(loanSchedules).where(and(
        eq(loanSchedules.tenantId, intake.tenantId), inArray(loanSchedules.id, scheduleIds),
    )).orderBy(loanSchedules.id) : [];
    const loanRows = loanIds.length ? await executor.select().from(loans).where(and(
        eq(loans.tenantId, intake.tenantId), inArray(loans.id, loanIds),
    )).orderBy(loans.id) : [];
    return hash(JSON.stringify({
        intake: { id: intake.id, amount: intake.amount, receivedAt: intake.receivedAt.toISOString() },
        allocations: allocations.map((item) => ({ loanId: item.loanId, scheduleId: item.scheduleId, amount: serializeMoney(item.amount) })),
        loans: loanRows.map((item: typeof loans.$inferSelect) => ({
            id: item.id,
            status: item.status,
            lateFeeMode: item.lateFeeMode,
            lateFeeAmount: item.lateFeeAmount,
            gracePeriodDays: item.gracePeriodDays,
            outstandingPrincipal: item.outstandingPrincipal,
            outstandingInterest: item.outstandingInterest,
            dailyInterestMode: item.dailyInterestMode,
            dailyInterestRate: item.dailyInterestRate,
            updatedAt: item.updatedAt?.toISOString(),
        })),
        schedules: scheduleRows.map((item: typeof loanSchedules.$inferSelect) => ({
            id: item.id, paidTotal: item.paidTotal, paidPenalty: item.paidPenalty, remainingDue: item.remainingDue,
            status: item.status, updatedAt: item.updatedAt?.toISOString(),
        })),
    }));
}

function utcDay(value: Date | string) {
    const date = new Date(value);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function schedulePenaltyDue(
    loan: typeof loans.$inferSelect,
    schedule: typeof loanSchedules.$inferSelect,
    asOf: Date,
) {
    if (new Decimal(schedule.remainingDue).lte(0)) return new Decimal(0);
    const overdueDays = Math.max(0, Math.floor((utcDay(asOf) - utcDay(schedule.dueDate)) / 86_400_000) - (loan.gracePeriodDays ?? 0));
    if (overdueDays === 0) return new Decimal(0);

    const rateOrAmount = new Decimal(loan.lateFeeAmount ?? 0);
    let accrued = new Decimal(0);
    if (loan.lateFeeMode === "fixed" || loan.lateFeeMode === "fixed_plus_percent") accrued = accrued.plus(rateOrAmount);
    if (loan.lateFeeMode === "daily_percent" || loan.lateFeeMode === "fixed_plus_percent") {
        accrued = accrued.plus(new Decimal(schedule.remainingDue).times(rateOrAmount).div(100).times(overdueDays));
    }
    return Decimal.max(0, accrued.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).minus(schedule.paidPenalty));
}

function scheduleLifecycle(
    loan: typeof loans.$inferSelect,
    schedule: typeof loanSchedules.$inferSelect,
    state: { remainingDue: Decimal; paidTotal: Decimal; paidPenalty: Decimal },
    asOf: Date,
) {
    const overdueDays = state.remainingDue.gt(0)
        ? Math.max(0, Math.floor((utcDay(asOf) - utcDay(schedule.dueDate)) / 86_400_000) - (loan.gracePeriodDays ?? 0))
        : 0;
    const penaltyDue = schedulePenaltyDue(loan, {
        ...schedule,
        remainingDue: signed(state.remainingDue),
        paidPenalty: signed(state.paidPenalty),
    }, asOf);
    const status = state.remainingDue.lte(0) && penaltyDue.isZero()
        ? "paid"
        : overdueDays > 0
            ? "overdue"
            : state.paidTotal.gt(0) || state.paidPenalty.gt(0)
                ? "partial"
                : "pending";
    return { overdueDays, status };
}

async function expandExplicit(
    executor: Executor,
    ctx: CommandContext,
    intake: IntakeRow,
    requested: ExplicitPaymentAllocation[],
    actor: Awaited<ReturnType<typeof actorFor>>,
) {
    const expanded: ExpandedAllocation[] = [];
    const warnings: Array<Record<string, unknown>> = [];
    const availableBySchedule = new Map<number, Decimal>();
    for (const [requestIndex, item] of requested.entries()) {
        requirePublicId(item.borrowerPublicId, `allocations[${requestIndex}].borrowerPublicId`);
        requirePublicId(item.loanPublicId, `allocations[${requestIndex}].loanPublicId`);
        if (item.schedulePublicId) requirePublicId(item.schedulePublicId, `allocations[${requestIndex}].schedulePublicId`);
        const amount = paymentMoney(item.amount);
        if (amount.isZero()) throw new DomainError("INVALID_PAYMENT_AMOUNT", "Allocation amount must be greater than zero", 400);
        const borrower = await executor.query.borrowers.findFirst({ where: and(eq(borrowers.publicId, item.borrowerPublicId), eq(borrowers.tenantId, ctx.tenantId)) });
        const loan = await executor.query.loans.findFirst({ where: and(eq(loans.publicId, item.loanPublicId), eq(loans.tenantId, ctx.tenantId)) });
        const outsidePortfolio = actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })
            && (loan?.ownerUserId !== actor.id || borrower?.ownerUserId !== actor.id);
        if (!borrower || !loan || loan.borrowerId !== borrower.id || loan.status !== "active" || outsidePortfolio) {
            throw new DomainError("INVALID_PAYMENT_TARGET", "Allocation borrower and active loan do not match", 400);
        }
        let schedules = await executor.select().from(loanSchedules).where(and(
            eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, loan.id),
        )).orderBy(loanSchedules.installmentNo);
        if (loan.repaymentType === "floating" && !item.schedulePublicId) {
            const dueInterest = await floatingInterestDue(executor, loan, intake.receivedAt, ctx.actorUserId);
            const available = dueInterest.plus(loan.outstandingPrincipal ?? loan.principalAmount);
            if (amount.gt(available)) warnings.push({ code: "ALLOCATION_EXCEEDS_OBLIGATION", loanPublicId: loan.publicId, unallocatedAmount: amount.minus(available).toFixed(2) });
            expanded.push({ borrowerId: borrower.id, borrowerPublicId: borrower.publicId, loanId: loan.id, loanPublicId: loan.publicId, scheduleId: null, schedulePublicId: null, amount: Decimal.min(amount, available).toFixed(2), matchReason: "explicit_floating" });
            continue;
        }
        if (item.schedulePublicId) {
            const start = schedules.findIndex((row: typeof loanSchedules.$inferSelect) => row.publicId === item.schedulePublicId);
            if (start < 0) throw new DomainError("INVALID_PAYMENT_TARGET", "Schedule does not belong to the allocation loan", 400);
            schedules = schedules.slice(start);
        }
        let remaining = amount;
        for (const schedule of schedules) {
            if (remaining.isZero()) break;
            const available = availableBySchedule.get(schedule.id)
                ?? new Decimal(schedule.remainingDue).plus(schedulePenaltyDue(loan, schedule, intake.receivedAt));
            if (available.lte(0)) continue;
            const allocated = Decimal.min(remaining, available).toDecimalPlaces(2);
            expanded.push({
                borrowerId: borrower.id,
                borrowerPublicId: borrower.publicId,
                loanId: loan.id,
                loanPublicId: loan.publicId,
                scheduleId: schedule.id,
                schedulePublicId: schedule.publicId,
                amount: allocated.toFixed(2),
                matchReason: "explicit",
            });
            availableBySchedule.set(schedule.id, available.minus(allocated));
            remaining = remaining.minus(allocated);
        }
        if (!remaining.isZero()) warnings.push({ code: "ALLOCATION_EXCEEDS_OBLIGATION", loanPublicId: loan.publicId, unallocatedAmount: remaining.toFixed(2) });
    }
    return { expanded, warnings };
}

async function automaticAllocation(executor: Executor, ctx: CommandContext, intake: IntakeRow, actor: Awaited<ReturnType<typeof actorFor>>) {
    const warnings: Array<Record<string, unknown>> = [];
    const query = normalizeBorrowerText(intake.payerName ?? "");
    if (!query) return { expanded: [] as ExpandedAllocation[], warnings: [{ code: "PAYER_NAME_REQUIRED" }] };
    let visibleBorrowers = await executor.select().from(borrowers).where(eq(borrowers.tenantId, ctx.tenantId));
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) visibleBorrowers = visibleBorrowers.filter((row: typeof borrowers.$inferSelect) => row.ownerUserId === actor.id);
    const visibleIds = visibleBorrowers.map((row: typeof borrowers.$inferSelect) => row.id);
    const aliases = visibleIds.length ? await executor.select().from(borrowerAliases).where(and(
        eq(borrowerAliases.tenantId, ctx.tenantId), eq(borrowerAliases.status, "confirmed"), inArray(borrowerAliases.borrowerId, visibleIds),
    )) : [];
    const matchingIds = new Set<number>();
    visibleBorrowers.filter((row: typeof borrowers.$inferSelect) => normalizeBorrowerText(row.name) === query).forEach((row: typeof borrowers.$inferSelect) => matchingIds.add(row.id));
    aliases.filter((row: typeof borrowerAliases.$inferSelect) => row.normalizedAlias === query).forEach((row: typeof borrowerAliases.$inferSelect) => matchingIds.add(row.borrowerId));
    if (matchingIds.size !== 1) {
        warnings.push({ code: matchingIds.size > 1 ? "AMBIGUOUS_BORROWER" : "BORROWER_NOT_CONFIRMED", candidateCount: matchingIds.size });
        return { expanded: [] as ExpandedAllocation[], warnings };
    }
    const borrower = visibleBorrowers.find((row: typeof borrowers.$inferSelect) => matchingIds.has(row.id))!;
    const activeLoans = await executor.select().from(loans).where(and(
        eq(loans.tenantId, ctx.tenantId), eq(loans.borrowerId, borrower.id), eq(loans.status, "active"),
    ));
    const visibleLoans = actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })
        ? activeLoans.filter((row: typeof loans.$inferSelect) => row.ownerUserId === actor.id)
        : activeLoans;
    const loanIds = visibleLoans.map((row: typeof loans.$inferSelect) => row.id);
    const candidateSchedules = loanIds.length ? await executor.select().from(loanSchedules).where(and(
        eq(loanSchedules.tenantId, ctx.tenantId), inArray(loanSchedules.loanId, loanIds),
    )) : [];
    const exactSchedules = candidateSchedules.filter((row: typeof loanSchedules.$inferSelect) => {
        const loan = visibleLoans.find((candidate: typeof loans.$inferSelect) => candidate.id === row.loanId)!;
        return new Decimal(row.remainingDue).plus(schedulePenaltyDue(loan, row, intake.receivedAt)).eq(intake.amount);
    });
    if (exactSchedules.length !== 1) {
        warnings.push({ code: exactSchedules.length > 1 ? "AMBIGUOUS_EXACT_OBLIGATION" : "NO_UNIQUE_EXACT_OBLIGATION", candidateCount: exactSchedules.length });
        return { expanded: [] as ExpandedAllocation[], warnings };
    }
    const schedule = exactSchedules[0]!;
    const loan = visibleLoans.find((row: typeof loans.$inferSelect) => row.id === schedule.loanId)!;
    return {
        expanded: [{
            borrowerId: borrower.id, borrowerPublicId: borrower.publicId,
            loanId: loan.id, loanPublicId: loan.publicId,
            scheduleId: schedule.id, schedulePublicId: schedule.publicId,
            amount: serializeMoney(intake.amount), matchReason: "unique_exact_obligation",
        }],
        warnings,
    };
}

export async function previewPaymentMatch(
    ctx: CommandContext,
    intakePublicId: string,
    input: { allocations?: ExplicitPaymentAllocation[] },
    executor?: Executor,
) {
    const existing = await accessibleIntake(ctx, intakePublicId, executor ?? db);
    if (["posted", "reversed", "duplicate"].includes(existing.status)) throw new DomainError("PAYMENT_INTAKE_IMMUTABLE", "This intake cannot be matched", 409);
    const run = async (tx: Executor) => {
        await tx.execute(sql`SELECT id FROM payment_intakes WHERE id = ${existing.id} FOR UPDATE`);
        const intake = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.id, existing.id), eq(paymentIntakes.tenantId, ctx.tenantId)) });
        if (!intake) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
        if (["posted", "reversed", "duplicate"].includes(intake.status)) {
            throw new DomainError("PAYMENT_INTAKE_IMMUTABLE", "This intake cannot be matched", 409);
        }
        const actor = await actorFor(ctx, tx);
        const requested = input.allocations;
        const match = requested
            ? await expandExplicit(tx, ctx, intake, requested, actor)
            : await automaticAllocation(tx, ctx, intake, actor);
        const requestedTotal = requested ? sumMoney(requested.map((item) => paymentMoney(item.amount))) : sumMoney(match.expanded.map((item) => item.amount));
        const warnings = [...match.warnings];
        if (!requestedTotal.eq(intake.amount)) warnings.push({ code: "ALLOCATION_SUM_MISMATCH", expected: serializeMoney(intake.amount), actual: serializeMoney(requestedTotal) });
        const status = requestedTotal.eq(intake.amount) && warnings.length === 0 && match.expanded.length > 0 ? "ready" : "needs_review";
        const prior = await tx.select().from(paymentMatchProposals).where(and(
            eq(paymentMatchProposals.tenantId, ctx.tenantId), eq(paymentMatchProposals.paymentIntakeId, intake.id),
        )).orderBy(desc(paymentMatchProposals.version));
        const version = (prior[0]?.version ?? 0) + 1;
        if (prior.length) {
            await tx.update(paymentMatchProposals).set({
                status: "stale", updatedByUserId: ctx.actorUserId, updatedAt: new Date(),
            }).where(and(
                eq(paymentMatchProposals.tenantId, ctx.tenantId),
                eq(paymentMatchProposals.paymentIntakeId, intake.id),
                inArray(paymentMatchProposals.status, ["draft", "ready", "needs_review"]),
            ));
        }
        const proposalHash = await stateHash(tx, intake, match.expanded);
        const proposal = await tx.insert(paymentMatchProposals).values({
            tenantId: ctx.tenantId,
            paymentIntakeId: intake.id,
            version,
            proposalHash,
            status,
            warnings,
            expiresAt: new Date(Date.now() + Math.max(60, Number(process.env.PAYMENT_PREVIEW_TTL_SECONDS ?? 900)) * 1000),
            createdByUserId: ctx.actorUserId,
            updatedByUserId: ctx.actorUserId,
        }).returning().then((rows: ProposalRow[]) => rows[0]!);
        const rows = match.expanded.length ? await tx.insert(paymentMatchAllocations).values(match.expanded.map((item, index) => ({
            tenantId: ctx.tenantId,
            proposalId: proposal.id,
            allocationOrder: index + 1,
            borrowerId: item.borrowerId,
            loanId: item.loanId,
            scheduleId: item.scheduleId,
            amount: item.amount,
            status: "proposed",
            matchReason: item.matchReason,
            createdByUserId: ctx.actorUserId,
            updatedByUserId: ctx.actorUserId,
        }))).returning() : [];
        await tx.update(paymentIntakes).set({ status, updatedByUserId: ctx.actorUserId, updatedAt: new Date() })
            .where(and(eq(paymentIntakes.id, intake.id), eq(paymentIntakes.tenantId, ctx.tenantId)));
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "payment_match_proposal", entityId: proposal.publicId, action: "previewed",
            payload: { intakePublicId: intake.publicId, version, status, totalAllocated: serializeMoney(requestedTotal), warningCodes: warnings.map((item) => item.code) },
        });
        return presentProposal(proposal, rows.map((row: AllocationRow, index: number) => ({ ...row, ...match.expanded[index] })), serializeMoney(requestedTotal));
    };
    return executor ? run(executor) : db.transaction(run);
}

function signed(value: Decimal.Value) {
    return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function allocateScheduleComponents(
    schedule: typeof loanSchedules.$inferSelect,
    loan: typeof loans.$inferSelect,
    amount: string,
    receivedAt: Date,
) {
    let remaining = new Decimal(amount);
    const penalty = Decimal.min(remaining, schedulePenaltyDue(loan, schedule, receivedAt));
    remaining = remaining.minus(penalty);
    const alreadyPaid = new Decimal(schedule.paidTotal);
    const feePaid = Decimal.min(alreadyPaid, schedule.scheduledFee);
    const afterFee = Decimal.max(0, alreadyPaid.minus(feePaid));
    const interestPaid = Decimal.min(afterFee, schedule.scheduledInterest);
    const afterInterest = Decimal.max(0, afterFee.minus(interestPaid));
    const principalPaid = Decimal.min(afterInterest, schedule.scheduledPrincipal);
    const fee = Decimal.min(remaining, Decimal.max(0, new Decimal(schedule.scheduledFee).minus(feePaid)));
    remaining = remaining.minus(fee);
    const interest = Decimal.min(remaining, Decimal.max(0, new Decimal(schedule.scheduledInterest).minus(interestPaid)));
    remaining = remaining.minus(interest);
    const principal = Decimal.min(remaining, Decimal.max(0, new Decimal(schedule.scheduledPrincipal).minus(principalPaid)));
    remaining = remaining.minus(principal);
    if (!remaining.isZero()) throw new DomainError("STALE_PAYMENT_PROPOSAL", "Allocation exceeds the latest schedule obligation", 409);
    return { fee, interest, principal, penalty };
}

async function writeFundEffects(tx: Executor, ctx: CommandContext, loanId: number, transactionId: number, entryDate: Date, components: Record<string, Decimal>) {
    const [funding, loan] = await Promise.all([
        tx.select().from(loanFundingAllocations).where(and(
            eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.loanId, loanId),
        )),
        tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, loanId)) }),
    ]);
    if (!loan) throw new DomainError("PAYMENT_TARGET_NOT_FOUND", "Funded loan no longer exists", 409);
    const netBySource = new Map<string, { bankProfileId: number; bankLoanId: number | null; amount: Decimal }>();
    for (const item of funding) {
        if (item.bankProfileId === null) continue;
        const key = `${item.bankProfileId}:${item.bankLoanId ?? "none"}`;
        const current = netBySource.get(key);
        netBySource.set(key, {
            bankProfileId: item.bankProfileId,
            bankLoanId: item.bankLoanId,
            amount: (current?.amount ?? new Decimal(0)).plus(item.allocatedAmount),
        });
    }
    const eligible = [...netBySource.values()]
        .filter((item) => item.amount.gt(0))
        .sort((a, b) => a.bankProfileId - b.bankProfileId || (a.bankLoanId ?? 0) - (b.bankLoanId ?? 0));
    const total = eligible.reduce((sum, item) => sum.plus(item.amount), new Decimal(0));
    const principal = new Decimal(loan.principalAmount);
    if (eligible.length === 0 || total.lte(0) || principal.lte(0)) return;
    const denominator = Decimal.max(principal, total);
    const fundedRatio = Decimal.min(1, total.div(principal));
    const entryTypes: Record<string, string> = { principal: "principal_return_in", interest: "interest_income_in", fee: "fee_income_in", penalty: "penalty_income_in" };
    for (const [component, value] of Object.entries(components)) {
        if (value.isZero()) continue;
        const fundedComponent = value.times(fundedRatio).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        if (fundedComponent.isZero()) continue;
        let assigned = new Decimal(0);
        for (const [index, allocation] of eligible.entries()) {
            const amount = index === eligible.length - 1
                ? fundedComponent.minus(assigned)
                : value.times(allocation.amount).div(denominator).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
            assigned = assigned.plus(amount);
            await tx.insert(fundLedgerEntries).values({
                tenantId: ctx.tenantId,
                bankProfileId: allocation.bankProfileId,
                bankLoanId: allocation.bankLoanId,
                loanId,
                transactionId,
                entryDate,
                entryType: entryTypes[component]!,
                amount: signed(amount),
                createdByUserId: ctx.actorUserId,
            });
        }
    }
}

function presentTransaction(row: typeof transactions.$inferSelect) {
    return {
        id: row.publicId,
        publicId: row.publicId,
        amount: signed(row.amount),
        principalComponent: signed(row.principalComponent),
        interestComponent: signed(row.interestComponent),
        feeComponent: signed(row.feeComponent),
        penaltyComponent: signed(row.penaltyComponent),
        entryType: row.entryType,
        postedAt: row.postedAt,
    };
}

async function postedResult(executor: Executor, intake: IntakeRow) {
    const rows = await executor.select().from(transactions).where(and(
        eq(transactions.tenantId, intake.tenantId), eq(transactions.paymentIntakeId, intake.id),
    )).orderBy(transactions.id);
    return { ...presentIntake(intake), transactions: rows.map(presentTransaction) };
}

async function refreshLoanRollups(tx: Executor, tenantId: string, loanIds: number[]) {
    for (const loanId of [...new Set(loanIds)]) {
        const loan = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, tenantId), eq(loans.id, loanId)) });
        if (loan?.repaymentType === "floating") continue;
        const schedules = await tx.select().from(loanSchedules).where(and(
            eq(loanSchedules.tenantId, tenantId), eq(loanSchedules.loanId, loanId),
        )).orderBy(loanSchedules.installmentNo);
        const rollup = computeLoanRollup(schedules);
        await tx.update(loans).set({
            outstandingPrincipal: serializeMoney(rollup.outstandingPrincipal),
            outstandingInterest: serializeMoney(rollup.outstandingInterest),
            outstandingFees: serializeMoney(rollup.outstandingFees),
            nextDueDate: rollup.nextDueDate,
            status: rollup.status,
            updatedAt: new Date(),
        }).where(and(eq(loans.tenantId, tenantId), eq(loans.id, loanId)));
    }
}

export async function postPayment(ctx: CommandContext, intakePublicId: string, input: { proposalPublicId: string }, executor?: Executor) {
    const accessible = await accessibleIntake(ctx, intakePublicId, executor ?? db);
    requirePublicId(input.proposalPublicId, "proposalId");
    const run = async (tx: Executor) => {
        await tx.execute(sql`SELECT id FROM payment_intakes WHERE id = ${accessible.id} FOR UPDATE`);
        const intake = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.id, accessible.id), eq(paymentIntakes.tenantId, ctx.tenantId)) });
        if (!intake) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
        if (intake.status === "posted" || intake.status === "reversed") return postedResult(tx, intake);
        if (intake.status !== "ready") {
            throw new DomainError("PAYMENT_NOT_READY", "Payment intake must be ready before posting", 409);
        }
        const proposal = await tx.query.paymentMatchProposals.findFirst({ where: and(
            eq(paymentMatchProposals.publicId, input.proposalPublicId),
            eq(paymentMatchProposals.paymentIntakeId, intake.id),
            eq(paymentMatchProposals.tenantId, ctx.tenantId),
        ) });
        if (!proposal) throw new DomainError("PAYMENT_PROPOSAL_NOT_FOUND", "Payment proposal not found", 404);
        await tx.execute(sql`SELECT id FROM payment_match_proposals WHERE id = ${proposal.id} FOR UPDATE`);
        if (proposal.status !== "ready" || (proposal.expiresAt && proposal.expiresAt.getTime() < Date.now())) {
            throw new DomainError("STALE_PAYMENT_PROPOSAL", "Payment proposal is not ready or has expired", 409);
        }
        const latest = await tx.select().from(paymentMatchProposals).where(and(
            eq(paymentMatchProposals.tenantId, ctx.tenantId), eq(paymentMatchProposals.paymentIntakeId, intake.id),
        )).orderBy(desc(paymentMatchProposals.version)).then((rows: ProposalRow[]) => rows[0]);
        if (latest?.id !== proposal.id) throw new DomainError("STALE_PAYMENT_PROPOSAL", "A newer payment proposal exists", 409);
        const allocations = await tx.select().from(paymentMatchAllocations).where(and(
            eq(paymentMatchAllocations.tenantId, ctx.tenantId), eq(paymentMatchAllocations.proposalId, proposal.id),
        )).orderBy(paymentMatchAllocations.allocationOrder);
        const loanIds: number[] = [...new Set<number>(allocations.map((item: AllocationRow) => item.loanId))].sort((a, b) => a - b);
        const scheduleIds: number[] = [...new Set<number>(allocations.map((item: AllocationRow) => item.scheduleId).filter((id: number | null): id is number => id !== null))].sort((a, b) => a - b);
        if (loanIds.length) await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(loanIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        if (scheduleIds.length) await tx.execute(sql`SELECT id FROM loan_schedules WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(scheduleIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        const actor = await actorFor(ctx, tx);
        if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
            const targetLoans = loanIds.length ? await tx.select().from(loans).where(and(
                eq(loans.tenantId, ctx.tenantId), inArray(loans.id, loanIds),
            )) : [];
            const borrowerIds: number[] = [...new Set<number>(targetLoans.map((item: typeof loans.$inferSelect) => item.borrowerId))];
            const targetBorrowers = borrowerIds.length ? await tx.select().from(borrowers).where(and(
                eq(borrowers.tenantId, ctx.tenantId), inArray(borrowers.id, borrowerIds),
            )) : [];
            if (targetLoans.length !== loanIds.length
                || targetLoans.some((item: typeof loans.$inferSelect) => item.ownerUserId !== actor.id)
                || targetBorrowers.length !== borrowerIds.length
                || targetBorrowers.some((item: typeof borrowers.$inferSelect) => item.ownerUserId !== actor.id)) {
                throw new DomainError("INVALID_PAYMENT_TARGET", "Payment target is outside the actor portfolio", 403);
            }
        }
        const currentHash = await stateHash(tx, intake, allocations);
        if (currentHash !== proposal.proposalHash) {
            await tx.update(paymentMatchProposals).set({ status: "stale", updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(eq(paymentMatchProposals.id, proposal.id));
            return { stale: true as const };
        }
        const createdTransactions: Array<typeof transactions.$inferSelect> = [];
        for (const allocation of allocations) {
            const loan = await tx.query.loans.findFirst({ where: and(eq(loans.id, allocation.loanId), eq(loans.tenantId, ctx.tenantId)) });
            if (!loan) throw new DomainError("STALE_PAYMENT_PROPOSAL", "Payment target no longer exists", 409);
            if (!allocation.scheduleId && loan.repaymentType === "floating") {
                const dueInterest = await floatingInterestDue(tx, loan, intake.receivedAt, ctx.actorUserId);
                const interest = Decimal.min(new Decimal(allocation.amount), dueInterest);
                const principal = new Decimal(allocation.amount).minus(interest);
                if (principal.gt(loan.outstandingPrincipal ?? loan.principalAmount)) throw new DomainError("STALE_PAYMENT_PROPOSAL", "Allocation exceeds the latest floating balance", 409);
                await tx.update(loans).set({ outstandingInterest: signed(dueInterest.minus(interest)), outstandingPrincipal: signed(new Decimal(loan.outstandingPrincipal ?? loan.principalAmount).minus(principal)), updatedAt: new Date() }).where(and(eq(loans.id, loan.id), eq(loans.tenantId, ctx.tenantId)));
                if (interest.gt(0)) {
                    let remainingInterest = interest;
                    const accruals = await tx.select().from(loanInterestAccruals).where(and(
                        eq(loanInterestAccruals.tenantId, ctx.tenantId),
                        eq(loanInterestAccruals.loanId, loan.id),
                        inArray(loanInterestAccruals.status, ["accrued", "due", "partially_paid"]),
                    )).orderBy(loanInterestAccruals.accrualDate);
                    for (const accrual of accruals) {
                        if (remainingInterest.lte(0)) break;
                        const due = new Decimal(accrual.interestAmount).minus(accrual.paidAmount);
                        const applied = Decimal.min(remainingInterest, due);
                        const paidAmount = new Decimal(accrual.paidAmount).plus(applied);
                        const status = paidAmount.eq(accrual.interestAmount)
                            ? "paid"
                            : accrual.periodEndDate
                                ? "partially_paid"
                                : "accrued";
                        await tx.update(loanInterestAccruals).set({ paidAmount: signed(paidAmount), status }).where(eq(loanInterestAccruals.id, accrual.id));
                        remainingInterest = remainingInterest.minus(applied);
                    }
                }
                const transaction = await tx.insert(transactions).values({ tenantId: ctx.tenantId, ownerUserId: loan.ownerUserId ?? ctx.actorUserId, loanId: loan.id, amount: signed(allocation.amount), principalComponent: signed(principal), interestComponent: signed(interest), feeComponent: "0.00", penaltyComponent: "0.00", type: "repayment", transactionDate: intake.receivedAt, recordedByUserId: ctx.actorUserId, paymentIntakeId: intake.id, entryType: "repayment", idempotencyKey: `payment:${intake.publicId}:${allocation.publicId}`, postedAt: new Date() }).returning().then((rows: Array<typeof transactions.$inferSelect>) => rows[0]!);
                createdTransactions.push(transaction);
                await writeFundEffects(tx, ctx, loan.id, transaction.id, intake.receivedAt, { fee: new Decimal(0), interest, principal, penalty: new Decimal(0) });
                continue;
            }
            if (!allocation.scheduleId) throw new DomainError("STALE_PAYMENT_PROPOSAL", "Payment allocation has no schedule", 409);
            const schedule = await tx.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.id, allocation.scheduleId), eq(loanSchedules.tenantId, ctx.tenantId)) });
            if (!schedule || !loan || schedule.loanId !== loan.id) throw new DomainError("STALE_PAYMENT_PROPOSAL", "Payment target no longer exists", 409);
            const components = allocateScheduleComponents(schedule, loan, allocation.amount, intake.receivedAt);
            const nonPenalty = components.fee.plus(components.interest).plus(components.principal);
            const newPaid = new Decimal(schedule.paidTotal).plus(nonPenalty);
            const newPaidPenalty = new Decimal(schedule.paidPenalty).plus(components.penalty);
            const newRemaining = Decimal.max(0, new Decimal(schedule.remainingDue).minus(nonPenalty));
            const lifecycle = scheduleLifecycle(loan, schedule, {
                paidTotal: newPaid,
                paidPenalty: newPaidPenalty,
                remainingDue: newRemaining,
            }, intake.receivedAt);
            await tx.update(loanSchedules).set({
                paidTotal: signed(newPaid),
                paidPenalty: signed(newPaidPenalty),
                remainingDue: signed(newRemaining),
                overdueDays: lifecycle.overdueDays,
                status: lifecycle.status,
                updatedAt: new Date(),
            }).where(and(eq(loanSchedules.id, schedule.id), eq(loanSchedules.tenantId, ctx.tenantId)));
            const transaction = await tx.insert(transactions).values({
                tenantId: ctx.tenantId,
                ownerUserId: loan.ownerUserId ?? ctx.actorUserId,
                loanId: loan.id,
                scheduleId: schedule.id,
                amount: signed(allocation.amount),
                principalComponent: signed(components.principal),
                interestComponent: signed(components.interest),
                feeComponent: signed(components.fee),
                penaltyComponent: signed(components.penalty),
                type: "repayment",
                transactionDate: intake.receivedAt,
                recordedByUserId: ctx.actorUserId,
                paymentIntakeId: intake.id,
                entryType: "repayment",
                idempotencyKey: `payment:${intake.publicId}:${allocation.publicId}`,
                postedAt: new Date(),
            }).returning().then((rows: Array<typeof transactions.$inferSelect>) => rows[0]!);
            createdTransactions.push(transaction);
            await writeFundEffects(tx, ctx, loan.id, transaction.id, intake.receivedAt, components);
        }
        await refreshLoanRollups(tx, ctx.tenantId, loanIds);
        await tx.update(paymentMatchAllocations).set({ status: "posted", updatedByUserId: ctx.actorUserId, updatedAt: new Date() })
            .where(and(eq(paymentMatchAllocations.tenantId, ctx.tenantId), eq(paymentMatchAllocations.proposalId, proposal.id)));
        await tx.update(paymentMatchProposals).set({ status: "posted", updatedByUserId: ctx.actorUserId, updatedAt: new Date() })
            .where(and(eq(paymentMatchProposals.tenantId, ctx.tenantId), eq(paymentMatchProposals.id, proposal.id)));
        const posted = await tx.update(paymentIntakes).set({
            status: "posted", postedAt: new Date(), postedByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId, updatedAt: new Date(),
        }).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, intake.id)))
            .returning().then((rows: IntakeRow[]) => rows[0]!);
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "payment_intake", entityId: posted.publicId, action: "posted",
            payload: { proposalPublicId: proposal.publicId, version: proposal.version, transactionPublicIds: createdTransactions.map((item) => item.publicId), amount: posted.amount },
        });
        return { ...presentIntake(posted), transactions: createdTransactions.map(presentTransaction) };
    };
    const result = executor ? await run(executor) : await db.transaction(run);
    if ("stale" in result) {
        throw new DomainError("STALE_PAYMENT_PROPOSAL", "Payment proposal no longer matches current balances", 409);
    }
    if (!executor) await invalidateTenantCache(ctx.tenantId);
    return result;
}

export async function reversePayment(ctx: CommandContext, intakePublicId: string, input: { reason: string }, executor?: Executor) {
    const reason = input.reason?.trim();
    if (!reason) throw new DomainError("REVERSAL_REASON_REQUIRED", "Payment reversal requires a reason", 400);
    const accessible = await accessibleIntake(ctx, intakePublicId, executor ?? db);
    const run = async (tx: Executor) => {
        await tx.execute(sql`SELECT id FROM payment_intakes WHERE id = ${accessible.id} FOR UPDATE`);
        const intake = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.id, accessible.id), eq(paymentIntakes.tenantId, ctx.tenantId)) });
        if (!intake) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
        if (intake.status === "reversed") return postedResult(tx, intake);
        if (intake.status !== "posted") throw new DomainError("PAYMENT_NOT_POSTED", "Only a posted payment can be reversed", 409);
        const originals = await tx.select().from(transactions).where(and(
            eq(transactions.tenantId, ctx.tenantId), eq(transactions.paymentIntakeId, intake.id), eq(transactions.entryType, "repayment"),
        )).orderBy(transactions.id);
        const loanIds: number[] = [...new Set<number>(originals.map((item: typeof transactions.$inferSelect) => item.loanId))].sort((a, b) => a - b);
        const scheduleIds: number[] = [...new Set<number>(originals.map((item: typeof transactions.$inferSelect) => item.scheduleId).filter((id: number | null): id is number => id !== null))].sort((a, b) => a - b);
        if (loanIds.length) await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(loanIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        if (scheduleIds.length) await tx.execute(sql`SELECT id FROM loan_schedules WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(scheduleIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        const reversals: Array<typeof transactions.$inferSelect> = [];
        for (const original of originals) {
            const existing = await tx.query.transactions.findFirst({ where: and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.reversedTransactionId, original.id)) });
            if (existing) { reversals.push(existing); continue; }
            const laterRepayments = (await tx.select().from(transactions).where(and(
                eq(transactions.tenantId, ctx.tenantId),
                original.scheduleId ? eq(transactions.scheduleId, original.scheduleId) : and(eq(transactions.loanId, original.loanId), sql`${transactions.scheduleId} IS NULL`),
                eq(transactions.entryType, "repayment"),
                gt(transactions.id, original.id),
            ))).filter((row: typeof transactions.$inferSelect) => row.paymentIntakeId !== intake.id);
            for (const later of laterRepayments) {
                const laterReversal = await tx.query.transactions.findFirst({ where: and(
                    eq(transactions.tenantId, ctx.tenantId), eq(transactions.reversedTransactionId, later.id),
                ) });
                if (!laterReversal) {
                    throw new DomainError("REVERSAL_NOT_LATEST", "Reverse later payments on this loan allocation first", 409);
                }
            }
            if (original.scheduleId) {
                const schedule = await tx.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.id, original.scheduleId), eq(loanSchedules.tenantId, ctx.tenantId)) });
                if (!schedule) throw new DomainError("REVERSAL_TARGET_MISSING", "Original schedule no longer exists", 409);
                const loan = await tx.query.loans.findFirst({ where: and(eq(loans.id, original.loanId), eq(loans.tenantId, ctx.tenantId)) });
                if (!loan) throw new DomainError("REVERSAL_TARGET_MISSING", "Original loan no longer exists", 409);
                const nonPenalty = new Decimal(original.principalComponent).plus(original.interestComponent).plus(original.feeComponent);
                const restoredPaid = Decimal.max(0, new Decimal(schedule.paidTotal).minus(nonPenalty));
                const restoredPenalty = Decimal.max(0, new Decimal(schedule.paidPenalty).minus(original.penaltyComponent));
                const restoredRemaining = new Decimal(schedule.remainingDue).plus(nonPenalty);
                const lifecycle = scheduleLifecycle(loan, schedule, { paidTotal: restoredPaid, paidPenalty: restoredPenalty, remainingDue: restoredRemaining }, intake.receivedAt);
                await tx.update(loanSchedules).set({ paidTotal: signed(restoredPaid), paidPenalty: signed(restoredPenalty), remainingDue: signed(restoredRemaining), overdueDays: lifecycle.overdueDays, status: lifecycle.status, updatedAt: new Date() }).where(and(eq(loanSchedules.id, schedule.id), eq(loanSchedules.tenantId, ctx.tenantId)));
            } else {
                const loan = await tx.query.loans.findFirst({ where: and(eq(loans.id, original.loanId), eq(loans.tenantId, ctx.tenantId)) });
                if (!loan) throw new DomainError("REVERSAL_TARGET_MISSING", "Original loan no longer exists", 409);
                if (loan.repaymentType === "floating") {
                    let interestToRestore = new Decimal(original.interestComponent);
                    const accruals = await tx.select().from(loanInterestAccruals).where(and(
                        eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.loanId, loan.id), sql`${loanInterestAccruals.status} <> 'reversed'`,
                    )).orderBy(desc(loanInterestAccruals.accrualDate), desc(loanInterestAccruals.id));
                    for (const accrual of accruals) {
                        if (interestToRestore.lte(0)) break;
                        const restored = Decimal.min(interestToRestore, new Decimal(accrual.paidAmount));
                        if (restored.eq(0)) continue;
                        const paidAmount = new Decimal(accrual.paidAmount).minus(restored);
                        const currentBusinessDate = new Intl.DateTimeFormat("en-CA", {
                            timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
                        }).format(new Date());
                        const status = paidAmount.eq(accrual.interestAmount)
                            ? "paid"
                            : accrual.periodEndDate
                                ? accrual.periodEndDate <= currentBusinessDate
                                    ? paidAmount.gt(0) ? "partially_paid" : "due"
                                    : "accruing"
                                : "accrued";
                        await tx.update(loanInterestAccruals).set({ paidAmount: signed(paidAmount), status })
                            .where(and(eq(loanInterestAccruals.id, accrual.id), eq(loanInterestAccruals.tenantId, ctx.tenantId)));
                        interestToRestore = interestToRestore.minus(restored);
                    }
                    if (interestToRestore.gt(0)) throw new DomainError("REVERSAL_INTEREST_MISMATCH", "Paid floating interest history cannot support this reversal", 409);
                    const refreshedAccruals = await tx.select().from(loanInterestAccruals).where(and(
                        eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.loanId, loan.id), sql`${loanInterestAccruals.status} <> 'reversed'`,
                    ));
                    const outstandingInterest = refreshedAccruals
                        .filter((accrual: typeof loanInterestAccruals.$inferSelect) => ["accrued", "due", "partially_paid"].includes(accrual.status))
                        .reduce((sum: Decimal, accrual: typeof loanInterestAccruals.$inferSelect) =>
                            sum.plus(new Decimal(accrual.interestAmount).minus(accrual.paidAmount)), new Decimal(0));
                    await tx.update(loans).set({
                        outstandingPrincipal: signed(new Decimal(loan.outstandingPrincipal ?? loan.principalAmount).plus(original.principalComponent)),
                        outstandingInterest: signed(outstandingInterest),
                        updatedAt: new Date(),
                    }).where(and(eq(loans.id, loan.id), eq(loans.tenantId, ctx.tenantId)));
                }
            }
            const reversal = await tx.insert(transactions).values({
                tenantId: ctx.tenantId,
                ownerUserId: original.ownerUserId,
                loanId: original.loanId,
                scheduleId: original.scheduleId,
                amount: signed(new Decimal(original.amount).negated()),
                principalComponent: signed(new Decimal(original.principalComponent).negated()),
                interestComponent: signed(new Decimal(original.interestComponent).negated()),
                feeComponent: signed(new Decimal(original.feeComponent).negated()),
                penaltyComponent: signed(new Decimal(original.penaltyComponent).negated()),
                type: "reversal",
                transactionDate: new Date(),
                recordedByUserId: ctx.actorUserId,
                paymentIntakeId: intake.id,
                entryType: "reversal",
                reversedTransactionId: original.id,
                idempotencyKey: `reversal:${original.publicId}`,
                postedAt: new Date(),
            }).returning().then((rows: Array<typeof transactions.$inferSelect>) => rows[0]!);
            reversals.push(reversal);
            const ledger = await tx.select().from(fundLedgerEntries).where(and(
                eq(fundLedgerEntries.tenantId, ctx.tenantId), eq(fundLedgerEntries.transactionId, original.id),
            ));
            for (const entry of ledger) {
                await tx.insert(fundLedgerEntries).values({
                    tenantId: ctx.tenantId,
                    bankProfileId: entry.bankProfileId,
                    bankLoanId: entry.bankLoanId,
                    loanId: entry.loanId,
                    transactionId: reversal.id,
                    entryDate: new Date(),
                    entryType: `${entry.entryType.replace(/_in$/, "")}_reversal_out`,
                    amount: signed(entry.amount),
                    createdByUserId: ctx.actorUserId,
                });
            }
        }
        await refreshLoanRollups(tx, ctx.tenantId, loanIds);
        const postedProposal = await tx.query.paymentMatchProposals.findFirst({ where: and(
            eq(paymentMatchProposals.tenantId, ctx.tenantId),
            eq(paymentMatchProposals.paymentIntakeId, intake.id),
            eq(paymentMatchProposals.status, "posted"),
        ) });
        if (postedProposal) {
            await tx.update(paymentMatchAllocations).set({ status: "reversed", updatedByUserId: ctx.actorUserId, updatedAt: new Date() })
                .where(and(eq(paymentMatchAllocations.tenantId, ctx.tenantId), eq(paymentMatchAllocations.proposalId, postedProposal.id)));
        }
        const reversed = await tx.update(paymentIntakes).set({ status: "reversed", updatedByUserId: ctx.actorUserId, updatedAt: new Date() })
            .where(and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, intake.id)))
            .returning().then((rows: Array<typeof paymentIntakes.$inferSelect>) => rows[0]!);
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "payment_intake", entityId: reversed.publicId, action: "reversed",
            payload: { reversedTransactionPublicIds: originals.map((item: typeof transactions.$inferSelect) => item.publicId), reversalTransactionPublicIds: reversals.map((item) => item.publicId), amount: reversed.amount, reason },
        });
        return postedResult(tx, reversed);
    };
    const result = executor ? await run(executor) : await db.transaction(run);
    if (!executor) await invalidateTenantCache(ctx.tenantId);
    return result;
}
