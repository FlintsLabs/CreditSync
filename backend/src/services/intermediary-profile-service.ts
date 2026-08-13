import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
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
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import { serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { normalizeIntermediaryText } from "./intermediary-service";

type Actor = typeof users.$inferSelect;
type Intermediary = typeof intermediaries.$inferSelect;
type BankAccount = typeof intermediaryBankAccounts.$inferSelect;
type Assignment = typeof loanIntermediaryAssignments.$inferSelect;
type AssignmentRole = "disbursement" | "collection" | "both";
const assignmentRoleOrder: Record<AssignmentRole, number> = { collection: 0, disbursement: 1, both: 2 };

export interface SaveIntermediaryBankAccountInput {
    bankCode: string;
    bankName: string;
    accountName: string;
    accountNumber: string;
    note?: string | null;
}

export interface AssignIntermediaryInput {
    intermediaryPublicId: string;
    role: AssignmentRole;
    effectiveFrom: string;
    note?: string | null;
}

export interface EndIntermediaryAssignmentInput {
    effectiveTo: string;
    reason?: string | null;
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

function commandKey(ctx: CommandContext) {
    const key = ctx.idempotencyKey?.trim();
    if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400);
    return key;
}

function fingerprint(value: Record<string, unknown>) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parsedTimestamp(value: string, field: "effectiveFrom" | "effectiveTo") {
    const parsed = new Date(value);
    if (!value || Number.isNaN(parsed.getTime())) {
        throw new DomainError("INVALID_ASSIGNMENT_DATE", `${field} must be a valid ISO 8601 timestamp`, 400);
    }
    return parsed;
}

function presentIntermediary(row: Intermediary) {
    return {
        publicId: row.publicId,
        name: row.name,
        aliases: row.aliases,
        notes: row.notes,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function presentBankAccount(row: BankAccount) {
    return {
        publicId: row.publicId,
        bankCode: row.bankCode,
        bankName: row.bankName,
        accountName: row.accountName,
        maskedAccountNumber: `•••• ${row.accountNumberLast4}`,
        status: row.status,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function presentAssignment(row: Assignment, related: {
    loanPublicId: string;
    intermediaryPublicId: string;
    borrowerPublicId?: string | null;
    borrowerName?: string | null;
    loanStatus?: string | null;
}) {
    return {
        publicId: row.publicId,
        loanPublicId: related.loanPublicId,
        intermediaryPublicId: related.intermediaryPublicId,
        role: row.role as AssignmentRole,
        effectiveFrom: row.effectiveFrom.toISOString(),
        effectiveTo: row.effectiveTo?.toISOString() ?? null,
        status: row.status as "active" | "ended",
        note: row.note,
        ...(related.borrowerPublicId === undefined ? {} : {
            borrowerPublicId: related.borrowerPublicId,
            borrowerName: related.borrowerName ?? null,
            loanStatus: related.loanStatus ?? null,
        }),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

async function actorFor(ctx: CommandContext, executor: any = db): Promise<Actor | null> {
    if (ctx.actorUserId === null) return null;
    const actor = await executor.query.users.findFirst({
        where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)),
    });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

function ownerAccessible(actor: Actor | null, ownerUserId: number | null) {
    return actor === null || canAccessTenantWideData({ role: actor.role ?? "viewer" }) || actor.id === ownerUserId;
}

async function intermediaryFor(ctx: CommandContext, publicId: string, actor: Actor | null, executor: any = db): Promise<Intermediary> {
    const row = await executor.query.intermediaries.findFirst({
        where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.publicId, publicId)),
    });
    if (!row || !ownerAccessible(actor, row.ownerUserId)) {
        throw new DomainError("INTERMEDIARY_NOT_FOUND", "Intermediary not found", 404);
    }
    return row;
}

async function loanFor(ctx: CommandContext, publicId: string, actor: Actor | null, executor: any = db) {
    const row = await executor.query.loans.findFirst({
        where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, publicId)),
    });
    if (!row || !ownerAccessible(actor, row.ownerUserId)) {
        throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    }
    return row;
}

async function lockCommand(executor: any, scope: string, ctx: CommandContext, key: string) {
    await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:${scope}:${key}`}, 0))`);
}

function priorAuditFingerprint(entry: typeof auditLogs.$inferSelect) {
    const payload = entry.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return typeof (payload as Record<string, unknown>).requestFingerprint === "string"
        ? (payload as Record<string, unknown>).requestFingerprint as string
        : null;
}

function priorBankAccountResult(entry: typeof auditLogs.$inferSelect): ReturnType<typeof presentBankAccount> | null {
    const payload = entry.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const after = (payload as Record<string, unknown>).after;
    if (!after || typeof after !== "object" || Array.isArray(after)) return null;
    const value = after as Record<string, unknown>;
    if (value.publicId !== entry.entityId
        || typeof value.maskedAccountNumber !== "string"
        || typeof value.bankName !== "string"
        || typeof value.accountName !== "string"
        || typeof value.createdAt !== "string"
        || typeof value.updatedAt !== "string") return null;
    return value as ReturnType<typeof presentBankAccount>;
}

function priorAssignmentResult(entry: typeof auditLogs.$inferSelect): ReturnType<typeof presentAssignment> | null {
    const payload = entry.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const after = (payload as Record<string, unknown>).after;
    if (!after || typeof after !== "object" || Array.isArray(after)) return null;
    const value = after as Record<string, unknown>;
    if (value.publicId !== entry.entityId
        || typeof value.loanPublicId !== "string"
        || typeof value.intermediaryPublicId !== "string"
        || !["disbursement", "collection", "both"].includes(String(value.role))
        || typeof value.effectiveFrom !== "string"
        || !(value.effectiveTo === null || typeof value.effectiveTo === "string")
        || !["active", "ended"].includes(String(value.status))
        || !(value.note === null || typeof value.note === "string")
        || typeof value.createdAt !== "string"
        || typeof value.updatedAt !== "string") return null;
    return value as ReturnType<typeof presentAssignment>;
}

async function priorCommandAudit(executor: any, ctx: CommandContext, entityType: string, action: string, key: string) {
    return executor.select().from(auditLogs).where(and(
        eq(auditLogs.tenantId, ctx.tenantId),
        eq(auditLogs.entityType, entityType),
        eq(auditLogs.action, action),
        sql`${auditLogs.payload}->>'idempotencyKey' = ${key}`,
    )).orderBy(desc(auditLogs.id)).limit(1).then((rows: Array<typeof auditLogs.$inferSelect>) => rows[0] ?? null);
}

export async function getIntermediaryProfile(ctx: CommandContext, publicId: string) {
    const actor = await actorFor(ctx);
    const intermediary = await intermediaryFor(ctx, publicId, actor);
    const assignmentConditions = [
        eq(loanIntermediaryAssignments.tenantId, ctx.tenantId),
        eq(loanIntermediaryAssignments.intermediaryId, intermediary.id),
    ];
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        assignmentConditions.push(eq(loans.ownerUserId, actor.id));
    }
    const [accountRows, assignmentRows] = await Promise.all([
        db.select().from(intermediaryBankAccounts).where(and(
            eq(intermediaryBankAccounts.tenantId, ctx.tenantId),
            eq(intermediaryBankAccounts.intermediaryId, intermediary.id),
        )).orderBy(desc(intermediaryBankAccounts.createdAt)),
        db.select({
            assignment: loanIntermediaryAssignments,
            loanPublicId: loans.publicId,
            loanStatus: loans.status,
            borrowerPublicId: borrowers.publicId,
            borrowerName: borrowers.name,
        }).from(loanIntermediaryAssignments)
            .innerJoin(loans, and(
                eq(loans.tenantId, loanIntermediaryAssignments.tenantId),
                eq(loans.id, loanIntermediaryAssignments.loanId),
            ))
            .innerJoin(borrowers, and(eq(borrowers.tenantId, loans.tenantId), eq(borrowers.id, loans.borrowerId)))
            .where(and(...assignmentConditions))
            .orderBy(desc(loanIntermediaryAssignments.effectiveFrom), desc(loanIntermediaryAssignments.id)),
    ]);
    return {
        ...presentIntermediary(intermediary),
        bankAccounts: accountRows.map(presentBankAccount),
        assignments: assignmentRows.map((row) => presentAssignment(row.assignment, {
            intermediaryPublicId: intermediary.publicId,
            loanPublicId: row.loanPublicId,
            loanStatus: row.loanStatus,
            borrowerPublicId: row.borrowerPublicId,
            borrowerName: row.borrowerName,
        })),
    };
}

export async function saveIntermediaryBankAccount(ctx: CommandContext, intermediaryPublicId: string, input: SaveIntermediaryBankAccountInput) {
    const idempotencyKey = commandKey(ctx);
    const actor = await actorFor(ctx);
    const bankName = input.bankName?.trim();
    const accountName = input.accountName?.trim();
    const bankCode = input.bankCode?.trim();
    const note = input.note?.trim() || null;
    const suppliedNumber = input.accountNumber?.trim();
    if (!bankCode || !/^[A-Z][A-Z0-9]{1,19}$/.test(bankCode)
        || !bankName || !accountName || !suppliedNumber || !/^[0-9\s-]+$/.test(suppliedNumber)) {
        throw new DomainError("INVALID_BANK_ACCOUNT", "Canonical bank code, bank name, account name, and a numeric account number are required", 400);
    }
    const accountDigits = suppliedNumber.replace(/[\s-]+/g, "");
    if (accountDigits.length < 5 || accountDigits.length > 32) {
        throw new DomainError("INVALID_BANK_ACCOUNT", "Account number must contain between 5 and 32 digits", 400);
    }
    await intermediaryFor(ctx, intermediaryPublicId, actor);
    const bankIdentity = normalizeIntermediaryText(bankCode);
    const accountNumberHash = createHash("sha256")
        .update(`${ctx.tenantId}\0${bankIdentity}\0${accountDigits}`)
        .digest("hex");
    const requestFingerprint = fingerprint({
        intermediaryPublicId,
        bankCode,
        bankName,
        accountName,
        accountNumberHash,
        note,
    });

    return db.transaction(async (tx) => {
        await lockCommand(tx, "intermediary-bank-account-save", ctx, idempotencyKey);
        const prior = await priorCommandAudit(tx, ctx, "intermediary_bank_account", "saved", idempotencyKey)
            ?? await priorCommandAudit(tx, ctx, "intermediary_bank_account", "created", idempotencyKey);
        if (prior) {
            if (priorAuditFingerprint(prior) !== requestFingerprint) {
                throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key was already used for a different bank-account command", 409);
            }
            const replay = priorBankAccountResult(prior);
            if (!replay) throw new DomainError("IDEMPOTENT_RESULT_NOT_FOUND", "Stored bank-account result is unavailable", 409);
            return replay;
        }

        await lockCommand(tx, "intermediary-bank-account-identity", ctx, accountNumberHash);

        const currentIntermediary = await intermediaryFor(ctx, intermediaryPublicId, actor, tx);
        if (currentIntermediary.status !== "active") {
            throw new DomainError("INTERMEDIARY_INACTIVE", "Inactive intermediary profiles cannot receive bank-account changes", 409);
        }
        const existing = await tx.query.intermediaryBankAccounts.findFirst({
            where: and(
                eq(intermediaryBankAccounts.tenantId, ctx.tenantId),
                eq(intermediaryBankAccounts.accountNumberHash, accountNumberHash),
            ),
        });
        const unresolvedLegacy = await tx.query.intermediaryBankAccounts.findFirst({
            where: and(
                eq(intermediaryBankAccounts.tenantId, ctx.tenantId),
                isNull(intermediaryBankAccounts.bankCode),
                eq(intermediaryBankAccounts.accountNumberLast4, accountDigits.slice(-4)),
            ),
        });
        if (!existing && unresolvedLegacy) {
            throw new DomainError(
                "BANK_ACCOUNT_LEGACY_IDENTITY_REVIEW_REQUIRED",
                "A legacy bank account with the same last four digits requires canonical identity review",
                409,
            );
        }
        if (existing && existing.intermediaryId !== currentIntermediary.id) {
            throw new DomainError("BANK_ACCOUNT_ALREADY_ASSIGNED", "Bank account is already assigned to another intermediary", 409);
        }
        const now = new Date();
        const row = existing
            ? await tx.update(intermediaryBankAccounts).set({
                bankCode,
                bankName,
                accountName,
                accountNumberLast4: accountDigits.slice(-4),
                status: "active",
                note,
                updatedByUserId: ctx.actorUserId,
                updatedAt: now,
            }).where(and(eq(intermediaryBankAccounts.tenantId, ctx.tenantId), eq(intermediaryBankAccounts.id, existing.id)))
                .returning().then((rows) => rows[0]!)
            : await tx.insert(intermediaryBankAccounts).values({
                tenantId: ctx.tenantId,
                intermediaryId: currentIntermediary.id,
                bankCode,
                bankName,
                accountName,
                accountNumberLast4: accountDigits.slice(-4),
                accountNumberHash,
                note,
                createdByUserId: ctx.actorUserId,
                updatedByUserId: ctx.actorUserId,
            }).returning().then((rows) => rows[0]!);
        const after = presentBankAccount(row);
        await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "intermediary_bank_account",
            entityId: row.publicId,
            action: existing ? "saved" : "created",
            payload: {
                before: existing ? presentBankAccount(existing) : null,
                after,
                intermediaryPublicId,
                idempotencyKey,
                requestFingerprint,
            },
        });
        return after;
    });
}

export async function assignIntermediaryToLoan(ctx: CommandContext, loanPublicId: string, input: AssignIntermediaryInput) {
    const idempotencyKey = commandKey(ctx);
    if (!["disbursement", "collection", "both"].includes(input.role)) {
        throw new DomainError("INVALID_INTERMEDIARY_ROLE", "Assignment role must be disbursement, collection, or both", 400);
    }
    const effectiveFrom = parsedTimestamp(input.effectiveFrom, "effectiveFrom");
    const note = input.note?.trim() || null;
    const actor = await actorFor(ctx);
    await Promise.all([
        loanFor(ctx, loanPublicId, actor),
        intermediaryFor(ctx, input.intermediaryPublicId, actor),
    ]);
    const requestFingerprint = fingerprint({
        loanPublicId,
        intermediaryPublicId: input.intermediaryPublicId,
        role: input.role,
        effectiveFrom: effectiveFrom.toISOString(),
        note,
    });

    try {
        return await db.transaction(async (tx) => {
            await lockCommand(tx, "loan-intermediary-assignment", ctx, idempotencyKey);
            const existingKey = await tx.query.loanIntermediaryAssignments.findFirst({
                where: and(
                    eq(loanIntermediaryAssignments.tenantId, ctx.tenantId),
                    eq(loanIntermediaryAssignments.idempotencyKey, idempotencyKey),
                ),
            });
            if (existingKey) {
                const [storedLoan, storedIntermediary, prior] = await Promise.all([
                    tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, existingKey.loanId)) }),
                    tx.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.id, existingKey.intermediaryId)) }),
                    priorCommandAudit(tx, ctx, "loan_intermediary_assignment", "assigned", idempotencyKey),
                ]);
                const sameCommand = storedLoan?.publicId === loanPublicId
                    && storedIntermediary?.publicId === input.intermediaryPublicId
                    && existingKey.role === input.role
                    && existingKey.effectiveFrom.getTime() === effectiveFrom.getTime()
                    && existingKey.note === note;
                if (!sameCommand || !storedLoan || !storedIntermediary) {
                    throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key was already used for a different assignment", 409);
                }
                if (!prior || prior.entityId !== existingKey.publicId) {
                    throw new DomainError("IDEMPOTENT_RESULT_NOT_FOUND", "Stored assignment result is unavailable", 409);
                }
                if (priorAuditFingerprint(prior) !== requestFingerprint) {
                    throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key was already used for a different assignment", 409);
                }
                const replay = priorAssignmentResult(prior);
                if (!replay) throw new DomainError("IDEMPOTENT_RESULT_NOT_FOUND", "Stored assignment result is unavailable", 409);
                return replay;
            }

            const [loan, intermediary] = await Promise.all([
                loanFor(ctx, loanPublicId, actor, tx),
                intermediaryFor(ctx, input.intermediaryPublicId, actor, tx),
            ]);
            if (intermediary.status !== "active") {
                throw new DomainError("INTERMEDIARY_INACTIVE", "Inactive intermediaries cannot be assigned to loans", 409);
            }
            const overlappingRoles = input.role === "both" ? ["disbursement", "collection", "both"] : [input.role, "both"];
            const overlapping = await tx.query.loanIntermediaryAssignments.findFirst({
                where: and(
                    eq(loanIntermediaryAssignments.tenantId, ctx.tenantId),
                    eq(loanIntermediaryAssignments.loanId, loan.id),
                    inArray(loanIntermediaryAssignments.role, overlappingRoles),
                    sql`(${loanIntermediaryAssignments.effectiveTo} IS NULL OR ${loanIntermediaryAssignments.effectiveTo} > ${effectiveFrom.toISOString()}::timestamptz)`,
                ),
            });
            if (overlapping) {
                throw new DomainError("INTERMEDIARY_ASSIGNMENT_OVERLAP", "Assignment overlaps existing responsibility for this loan and role", 409);
            }
            const row = await tx.insert(loanIntermediaryAssignments).values({
                tenantId: ctx.tenantId,
                loanId: loan.id,
                intermediaryId: intermediary.id,
                role: input.role,
                effectiveFrom,
                idempotencyKey,
                note,
                createdByUserId: ctx.actorUserId,
                updatedByUserId: ctx.actorUserId,
            }).returning().then((rows) => rows[0]!);
            const after = presentAssignment(row, { loanPublicId, intermediaryPublicId: input.intermediaryPublicId });
            await createAuditLog(tx, {
                ...auditContext(ctx),
                entityType: "loan_intermediary_assignment",
                entityId: row.publicId,
                action: "assigned",
                payload: { before: null, after, idempotencyKey, requestFingerprint },
            });
            return after;
        });
    } catch (error) {
        if (error instanceof DomainError) throw error;
        if (error && typeof error === "object" && "code" in error && error.code === "23P01") {
            throw new DomainError("INTERMEDIARY_ASSIGNMENT_OVERLAP", "Assignment overlaps existing responsibility for this loan and role", 409);
        }
        throw error;
    }
}

export async function endIntermediaryAssignment(ctx: CommandContext, assignmentPublicId: string, input: EndIntermediaryAssignmentInput) {
    const idempotencyKey = commandKey(ctx);
    const effectiveTo = parsedTimestamp(input.effectiveTo, "effectiveTo");
    const reason = input.reason?.trim() || null;
    const actor = await actorFor(ctx);
    const requestFingerprint = fingerprint({ assignmentPublicId, effectiveTo: effectiveTo.toISOString(), reason });

    return db.transaction(async (tx) => {
        await lockCommand(tx, "loan-intermediary-assignment-end", ctx, idempotencyKey);
        const prior = await priorCommandAudit(tx, ctx, "loan_intermediary_assignment", "ended", idempotencyKey);
        if (prior) {
            if (prior.entityId !== assignmentPublicId || priorAuditFingerprint(prior) !== requestFingerprint) {
                throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key was already used for a different assignment end command", 409);
            }
            const replay = await tx.query.loanIntermediaryAssignments.findFirst({
                where: and(eq(loanIntermediaryAssignments.tenantId, ctx.tenantId), eq(loanIntermediaryAssignments.publicId, assignmentPublicId)),
            });
            if (!replay) throw new DomainError("IDEMPOTENT_RESULT_NOT_FOUND", "Stored assignment result is unavailable", 409);
            const [loan, intermediary] = await Promise.all([
                tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, replay.loanId)) }),
                tx.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.id, replay.intermediaryId)) }),
            ]);
            if (!loan || !intermediary || !ownerAccessible(actor, loan.ownerUserId) || !ownerAccessible(actor, intermediary.ownerUserId)) {
                throw new DomainError("INTERMEDIARY_ASSIGNMENT_NOT_FOUND", "Intermediary assignment not found", 404);
            }
            return presentAssignment(replay, { loanPublicId: loan.publicId, intermediaryPublicId: intermediary.publicId });
        }

        const existing = await tx.query.loanIntermediaryAssignments.findFirst({
            where: and(eq(loanIntermediaryAssignments.tenantId, ctx.tenantId), eq(loanIntermediaryAssignments.publicId, assignmentPublicId)),
        });
        if (!existing) throw new DomainError("INTERMEDIARY_ASSIGNMENT_NOT_FOUND", "Intermediary assignment not found", 404);
        const [loan, intermediary] = await Promise.all([
            tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, existing.loanId)) }),
            tx.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.id, existing.intermediaryId)) }),
        ]);
        if (!loan || !intermediary || !ownerAccessible(actor, loan.ownerUserId) || !ownerAccessible(actor, intermediary.ownerUserId)) {
            throw new DomainError("INTERMEDIARY_ASSIGNMENT_NOT_FOUND", "Intermediary assignment not found", 404);
        }
        if (existing.status !== "active") {
            throw new DomainError("INTERMEDIARY_ASSIGNMENT_ENDED", "Intermediary assignment has already ended", 409);
        }
        if (effectiveTo.getTime() <= existing.effectiveFrom.getTime()) {
            throw new DomainError("INVALID_ASSIGNMENT_DATE", "effectiveTo must be after effectiveFrom", 400);
        }
        const row = await tx.update(loanIntermediaryAssignments).set({
            effectiveTo,
            status: "ended",
            updatedByUserId: ctx.actorUserId,
            updatedAt: new Date(),
        }).where(and(
            eq(loanIntermediaryAssignments.tenantId, ctx.tenantId),
            eq(loanIntermediaryAssignments.id, existing.id),
            eq(loanIntermediaryAssignments.status, "active"),
        )).returning().then((rows) => rows[0]);
        if (!row) throw new DomainError("INTERMEDIARY_ASSIGNMENT_ENDED", "Intermediary assignment has already ended", 409);
        const before = presentAssignment(existing, { loanPublicId: loan.publicId, intermediaryPublicId: intermediary.publicId });
        const after = presentAssignment(row, { loanPublicId: loan.publicId, intermediaryPublicId: intermediary.publicId });
        await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "loan_intermediary_assignment",
            entityId: row.publicId,
            action: "ended",
            payload: { before, after, reason, idempotencyKey, requestFingerprint },
        });
        return after;
    });
}

export async function listManagedLoans(
    ctx: CommandContext,
    intermediaryPublicId: string,
    input: { role?: "disbursement" | "collection" | "all" } = {},
) {
    const actor = await actorFor(ctx);
    const intermediary = await intermediaryFor(ctx, intermediaryPublicId, actor);
    const asOf = new Date();
    const conditions = [
        eq(loanIntermediaryAssignments.tenantId, ctx.tenantId),
        eq(loanIntermediaryAssignments.intermediaryId, intermediary.id),
        lte(loanIntermediaryAssignments.effectiveFrom, asOf),
        sql`(${loanIntermediaryAssignments.effectiveTo} IS NULL OR ${loanIntermediaryAssignments.effectiveTo} > ${asOf.toISOString()}::timestamptz)`,
        eq(loans.status, "active"),
    ];
    if (input.role && input.role !== "all") {
        conditions.push(inArray(loanIntermediaryAssignments.role, [input.role, "both"]));
    }
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        conditions.push(eq(loans.ownerUserId, actor.id));
    }
    const rows = await db.select({
        assignment: loanIntermediaryAssignments,
        loan: loans,
        borrowerPublicId: borrowers.publicId,
        borrowerName: borrowers.name,
    }).from(loanIntermediaryAssignments)
        .innerJoin(loans, and(
            eq(loans.tenantId, loanIntermediaryAssignments.tenantId),
            eq(loans.id, loanIntermediaryAssignments.loanId),
        ))
        .innerJoin(borrowers, and(eq(borrowers.tenantId, loans.tenantId), eq(borrowers.id, loans.borrowerId)))
        .where(and(...conditions))
        .orderBy(loans.nextDueDate, loans.id, loanIntermediaryAssignments.id);

    const managedByLoan = new Map<string, {
        publicId: string;
        borrowerPublicId: string;
        borrowerName: string;
        principalAmount: string;
        outstandingPrincipal: string;
        outstandingInterest: string;
        outstandingFees: string;
        repaymentType: string;
        startDate: string | null;
        nextDueDate: string | null;
        status: string | null;
        roles: AssignmentRole[];
        assignments: Array<ReturnType<typeof presentAssignment>>;
    }>();
    for (const row of rows) {
        const assignment = presentAssignment(row.assignment, {
            loanPublicId: row.loan.publicId,
            intermediaryPublicId: intermediary.publicId,
        });
        const existing = managedByLoan.get(row.loan.publicId);
        if (existing) {
            if (!existing.roles.includes(assignment.role)) existing.roles.push(assignment.role);
            existing.assignments.push(assignment);
            continue;
        }
        managedByLoan.set(row.loan.publicId, {
            publicId: row.loan.publicId,
            borrowerPublicId: row.borrowerPublicId,
            borrowerName: row.borrowerName,
            principalAmount: serializeMoney(row.loan.principalAmount),
            outstandingPrincipal: serializeMoney(row.loan.outstandingPrincipal ?? "0"),
            outstandingInterest: serializeMoney(row.loan.outstandingInterest ?? "0"),
            outstandingFees: serializeMoney(row.loan.outstandingFees ?? "0"),
            repaymentType: row.loan.repaymentType,
            startDate: row.loan.startDate,
            nextDueDate: row.loan.nextDueDate,
            status: row.loan.status,
            roles: [assignment.role],
            assignments: [assignment],
        });
    }
    for (const managed of managedByLoan.values()) {
        managed.roles.sort((left, right) => assignmentRoleOrder[left] - assignmentRoleOrder[right]);
        managed.assignments.sort((left, right) => assignmentRoleOrder[left.role] - assignmentRoleOrder[right.role]
            || left.publicId.localeCompare(right.publicId));
    }
    return [...managedByLoan.values()];
}
