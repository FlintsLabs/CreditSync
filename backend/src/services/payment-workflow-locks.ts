import { sql } from "drizzle-orm";
import { db, type DbExecutor, type DbTransaction } from "../db";
import type { CommandContext } from "./command-context";

const transientSqlStates = new Set(["40P01", "40001"]);

export async function lockPaymentWorkflowIdentity(ctx: CommandContext, executor: DbExecutor, keys: readonly string[]) {
    const uniqueKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))].sort();
    for (const key of uniqueKeys) {
        await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-workflow:${ctx.tenantId}:${key}`}, 0))`);
    }
}

export function isTransientPaymentWorkflowError(error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    return transientSqlStates.has(code);
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
