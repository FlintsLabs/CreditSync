import { sql } from "drizzle-orm";
import { db, type DbExecutor, type DbTransaction } from "../db";
import type { CommandContext } from "./command-context";

const transientSqlStates = new Set(["40P01", "40001"]);

export async function lockPaymentWorkflowTenant(ctx: Pick<CommandContext, "tenantId">, executor: DbExecutor) {
    await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-workflow-tenant:${ctx.tenantId}`}, 0))`);
}

export async function lockPaymentWorkflowIdentity(ctx: CommandContext, executor: DbExecutor, keys: readonly string[]) {
    // Every participating writer takes the tenant mutex first.  The tenant
    // mutex is intentionally not part of the sortable key set: putting it in
    // lexical order allowed a path taking a row lock first to deadlock with a
    // path taking the identity mutex first.
    await lockPaymentWorkflowTenant(ctx, executor);
    const uniqueKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))].sort();
    for (const key of uniqueKeys) {
        await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-workflow:${ctx.tenantId}:${key}`}, 0))`);
    }
}

export function isTransientPaymentWorkflowError(error: unknown) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current; depth += 1) {
        if (typeof current === "object" && current !== null && "code" in current) {
            const code = String((current as { code?: unknown }).code ?? "");
            if (transientSqlStates.has(code)) return true;
        }
        current = typeof current === "object" && current !== null && "cause" in current
            ? (current as { cause?: unknown }).cause
            : undefined;
    }
    return false;
}

/** Replays the complete transaction, at most three times, only for PostgreSQL serialization/deadlock errors. */
export async function withPaymentWorkflowTransaction<T>(run: (tx: DbTransaction) => Promise<T>, options: { maxAttempts?: number; backoffMs?: number } = {}) {
    const maxAttempts = Math.min(3, Math.max(1, options.maxAttempts ?? 3));
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await db.transaction(run);
        } catch (error) {
            if (!isTransientPaymentWorkflowError(error) || attempt === maxAttempts) throw error;
            const delay = Math.min(250, Math.max(0, options.backoffMs ?? 25) * attempt);
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    throw new Error("Payment workflow transaction exhausted retry attempts");
}
