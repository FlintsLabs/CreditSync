import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { loanCancellationPreviews } from "./schema";

test("loan cancellation previews persist closed, tenant-scoped execution state", () => {
    const config = getTableConfig(loanCancellationPreviews);
    expect(config.name).toBe("loan_cancellation_previews");
    expect(config.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "public_id", "tenant_id", "loan_id", "reason", "before_snapshot",
        "balance_version", "preview_hash", "status", "execute_idempotency_key",
        "executed_audit_public_id", "correlation_id", "expires_at",
    ]));
    expect(config.checks.find((check) => check.name === "loan_cancellation_previews_status_check")).toBeDefined();
    expect(config.indexes.find((index) => index.config.name === "loan_cancellation_previews_tenant_execute_idempotency_unique")).toBeDefined();
});
