import { db } from "../db";
import { auditLogs } from "../db/schema";

interface CreateAuditLogInput {
    tenantId: string;
    actorUserId?: number | null;
    entityType: string;
    entityId: string | number;
    action: string;
    payload?: unknown;
}

export async function createAuditLog(executor: any, input: CreateAuditLogInput) {
    await executor.insert(auditLogs).values({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        entityType: input.entityType,
        entityId: String(input.entityId),
        action: input.action,
        payload: input.payload ?? null,
    });
}

export async function writeAuditLog(input: CreateAuditLogInput) {
    await db.insert(auditLogs).values({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        entityType: input.entityType,
        entityId: String(input.entityId),
        action: input.action,
        payload: input.payload ?? null,
    });
}
