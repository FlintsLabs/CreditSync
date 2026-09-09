import { db } from "../db";
import { auditLogs } from "../db/schema";

export interface CreateAuditLogInput {
    tenantId: string;
    actorUserId?: number | null;
    actorSource?: "web" | "mcp" | "system";
    requestId?: string | null;
    correlationId?: string | null;
    entityType: string;
    entityId: string | number;
    action: string;
    payload?: unknown;
}

export async function createAuditLog(executor: any, input: CreateAuditLogInput) {
    return await executor.insert(auditLogs).values({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        actorSource: input.actorSource ?? "system",
        requestId: input.requestId ?? null,
        correlationId: input.correlationId ?? null,
        entityType: input.entityType,
        entityId: String(input.entityId),
        action: input.action,
        payload: input.payload ?? null,
    }).returning().then((rows: Array<typeof auditLogs.$inferSelect>) => rows[0]!);
}

export async function writeAuditLog(input: CreateAuditLogInput) {
    await db.insert(auditLogs).values({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        actorSource: input.actorSource ?? "system",
        requestId: input.requestId ?? null,
        correlationId: input.correlationId ?? null,
        entityType: input.entityType,
        entityId: String(input.entityId),
        action: input.action,
        payload: input.payload ?? null,
    });
}
