import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

const root = `${import.meta.dir}/../../`;

test("defines a tenant-safe typed sticky evidence requirement", async () => {
    const [migration, journal, schema] = await Promise.all([
        Bun.file(`${root}drizzle/0075_financial_evidence_requirements.sql`).text(),
        Bun.file(`${root}drizzle/meta/_journal.json`).json(),
        import("./schema"),
    ]);
    expect(journal.entries.at(-1)).toMatchObject({ idx: 75, tag: "0075_financial_evidence_requirements" });
    expect(migration).toContain('CREATE TABLE "financial_evidence_requirements"');
    expect(migration).toContain("financial_evidence_requirements_target_xor_check");
    expect(migration).toContain("financial_evidence_requirements_expected_count_check");
    expect(migration).toContain("financial_evidence_requirements_tenant_payment_fk");
    expect(migration).toContain("financial_evidence_requirements_tenant_disbursement_fk");
    expect(migration).not.toMatch(/UPDATE\s+(?:payment_intakes|loan_disbursement_events)/i);

    const table = getTableConfig(schema.financialEvidenceRequirements);
    expect(table.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "public_id", "tenant_id", "payment_intake_id", "loan_disbursement_event_id", "expected_count", "source", "request_id", "correlation_id",
    ]));
    expect(table.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
        "financial_evidence_requirements_target_xor_check",
        "financial_evidence_requirements_expected_count_check",
    ]));
    expect(table.foreignKeys).toHaveLength(3);
});
