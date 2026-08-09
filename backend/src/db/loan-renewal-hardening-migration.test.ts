import { describe, expect, test } from "bun:test";

const backendRoot = `${import.meta.dir}/../../`;
const migrationPath = `${backendRoot}drizzle/0011_loan_renewal_hardening.sql`;

describe("loan renewal hardening migration contract", () => {
    test("registers an additive migration with structural funding provenance and reversal state", async () => {
        const journal = await Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json();
        expect(journal.entries.find((entry: { tag: string }) => entry.tag === "0011_loan_renewal_hardening"))
            .toMatchObject({ idx: 11, tag: "0011_loan_renewal_hardening" });

        const file = Bun.file(migrationPath);
        expect(await file.exists()).toBe(true);
        const migration = await file.text();
        expect(migration).toContain('ADD COLUMN "renewal_id" integer');
        expect(migration).toContain('ADD COLUMN "allocation_group_id" uuid');
        expect(migration).toContain('ADD COLUMN "reversed_allocation_id" integer');
        expect(migration).toContain('ADD COLUMN "pre_execution_loan_state" jsonb');
        expect(migration).toContain('ADD COLUMN "reversal_idempotency_key" text');
        expect(migration).toContain('ADD COLUMN "reversal_request_hash" text');
        expect(migration).toContain('loan_funding_allocations_tenant_renewal_fk');
        expect(migration).toContain('loan_funding_allocations_tenant_reversed_allocation_fk');
        expect(migration).toContain('loan_renewals_tenant_reversal_idempotency_unique');
        expect(migration).not.toMatch(/\bDROP\b/i);
    });
});
