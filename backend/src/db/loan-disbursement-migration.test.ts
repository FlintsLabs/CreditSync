import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

const backendRoot = `${import.meta.dir}/../../`;

test("registers the additive immutable loan disbursement ledger migration", async () => {
    const [journal, sql] = await Promise.all([
        Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json(),
        Bun.file(`${backendRoot}drizzle/0019_loan_disbursement_events.sql`).text(),
    ]);

    expect(sql).toContain('CREATE TABLE "loan_disbursement_events"');
    expect(sql).toContain('"gross_amount" numeric NOT NULL');
    expect(sql).toContain('"loan_attributed_amount" numeric NOT NULL');
    expect(sql).toContain('CREATE TABLE "loan_disbursement_evidence"');
    expect(sql).toContain('loan_disbursement_events_channel_check');
    expect(sql).toContain('loan_disbursement_events_status_check');
    expect(sql).toContain('loan_disbursement_events_money_check');
    expect(sql).toContain('loan_disbursement_events_tenant_loan_status_idx');
    expect(sql).toContain('loan_disbursement_events_tenant_id_id_unique');
    expect(sql).toContain('FOREIGN KEY ("tenant_id", "loan_disbursement_event_id") REFERENCES "loan_disbursement_events"("tenant_id", "id")');
    expect(sql).toContain('FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")');
    expect(sql).toContain('CREATE FUNCTION reject_posted_loan_disbursement_event_mutation()');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "loan_disbursement_events"');
    expect(sql).toContain("loan_disbursement_events posted records are immutable");
    expect(journal.entries.at(-1)?.tag).toBe("0019_loan_disbursement_events");
});

test("declares disbursement events and tenant-scoped evidence links", async () => {
    const { loanDisbursementEvidence, loanDisbursementEvents } = await import("./schema");
    const eventConfig = getTableConfig(loanDisbursementEvents);
    const evidenceConfig = getTableConfig(loanDisbursementEvidence);

    expect(eventConfig.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "public_id", "tenant_id", "loan_id", "gross_amount", "loan_attributed_amount",
        "channel", "source_bank_profile_id", "payee_hint", "status", "reversed_event_id",
        "note", "disbursed_at", "posted_at", "reversed_at", "created_by_user_id", "created_at",
    ]));
    expect(eventConfig.indexes.some((index) => index.config.name === "loan_disbursement_events_tenant_loan_status_idx")).toBe(true);
    expect(eventConfig.indexes.some((index) => index.config.name === "loan_disbursement_events_tenant_id_id_unique" && index.config.unique)).toBe(true);
    expect(eventConfig.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
        "loan_disbursement_events_channel_check",
        "loan_disbursement_events_status_check",
        "loan_disbursement_events_money_check",
    ]));
    expect(evidenceConfig.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "tenant_id", "loan_disbursement_event_id", "file_id", "created_at",
    ]));
    expect(evidenceConfig.indexes.some((index) => index.config.name === "loan_disbursement_evidence_event_file_unique")).toBe(true);
    for (const [columnName, foreignTableName] of [
        ["loan_disbursement_event_id", "loan_disbursement_events"],
        ["file_id", "files"],
    ]) {
        const foreignKey = evidenceConfig.foreignKeys.find((candidate) => {
            const reference = candidate.reference();
            return reference.columns.some((column) => column.name === columnName)
                && getTableConfig(reference.foreignTable).name === foreignTableName;
        });
        expect(foreignKey, `missing tenant-safe ${columnName} foreign key`).toBeDefined();
        const reference = foreignKey!.reference();
        expect(reference.columns.map((column) => column.name)).toEqual(["tenant_id", columnName]);
        expect(reference.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
    }
});
