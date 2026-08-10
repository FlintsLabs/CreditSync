import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

const backendRoot = `${import.meta.dir}/../../`;

test("registers an additive tenant-safe origin loan for payment intakes", async () => {
    const [journal, migration] = await Promise.all([
        Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json(),
        Bun.file(`${backendRoot}drizzle/0022_payment_intake_origin_loan.sql`).text(),
    ]);
    const { paymentIntakes } = await import("./schema");
    const config = getTableConfig(paymentIntakes);

    expect(journal.entries.at(-1)).toMatchObject({ idx: 22, tag: "0022_payment_intake_origin_loan" });
    expect(migration).toContain('ALTER TABLE "payment_intakes" ADD COLUMN "origin_loan_id" integer');
    expect(migration).toContain('FOREIGN KEY ("tenant_id", "origin_loan_id") REFERENCES "loans"("tenant_id", "id")');
    expect(migration).not.toMatch(/\bDROP\b/i);
    expect(config.columns.map((column) => column.name)).toContain("origin_loan_id");
    const originLoanForeignKey = config.foreignKeys.find((foreignKey) => foreignKey.reference().columns.some((column) => column.name === "origin_loan_id"));
    expect(originLoanForeignKey).toBeDefined();
    expect(originLoanForeignKey!.reference().columns.map((column) => column.name)).toEqual(["tenant_id", "origin_loan_id"]);
    expect(originLoanForeignKey!.reference().foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
});
