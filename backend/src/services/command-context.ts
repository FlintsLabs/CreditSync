export type ActorSource = "web" | "mcp" | "system";

export interface CommandContext {
    tenantId: string;
    actorUserId: number | null;
    actorSource: ActorSource;
    requestId: string;
    correlationId: string;
    idempotencyKey?: string;
}
