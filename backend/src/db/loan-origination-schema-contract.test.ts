import { expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve } from "node:path";
import {
    assertCompatibleLoanOriginationSchema,
    inspectLoanOriginationSchema,
    type SchemaCatalogExecutor,
} from "./loan-origination-schema-contract";

type Catalog = {
    columns?: Array<{ table: string; name: string; type: string; nullable: boolean; numericPrecision?: number | null; numericScale?: number | null }>;
    constraints?: Array<{ table: string; name: string; definition: string }>;
    indexes?: Array<{ table: string; name: string; definition: string; predicate: string | null }>;
};

const fakeCatalog = (catalog: Catalog): SchemaCatalogExecutor => {
    return (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.reduce((result, part, index) => `${result}${part}${values[index] ?? ""}`, "");
        expect(query).toMatch(/information_schema\.columns|pg_constraint|pg_indexes|drizzle\.__drizzle_migrations/);
        expect(query).not.toMatch(/\bSELECT\s+\*\s+FROM\s+(borrowers|loans)\b/i);

        if (query.includes("information_schema.columns")) return Promise.resolve(catalog.columns ?? []);
        if (query.includes("pg_constraint")) return Promise.resolve(catalog.constraints ?? []);
        if (query.includes("pg_indexes")) return Promise.resolve(catalog.indexes ?? []);
        return Promise.resolve([]);
    };
};

test("accepts PostgreSQL canonical constraint and partial-index definitions", async () => {
    const report = await inspectLoanOriginationSchema(fakeCatalog({
        columns: [
            { table: "loans", name: "activation_idempotency_key", type: "text", nullable: true },
            { table: "loans", name: "activation_result", type: "jsonb", nullable: true },
        ],
        constraints: [
            { table: "loans", name: "loans_interest_period_unit_check", definition: `CHECK ((interest_period_unit IS NULL) OR (interest_period_unit = ANY (ARRAY['day'::text, 'week'::text])))` },
        ],
        indexes: [
            { table: "loans", name: "loans_tenant_activation_idempotency_unique", definition: "CREATE UNIQUE INDEX loans_tenant_activation_idempotency_unique ON public.loans USING btree (tenant_id, activation_idempotency_key) WHERE (activation_idempotency_key IS NOT NULL)", predicate: "(activation_idempotency_key IS NOT NULL)" },
        ],
    }));

    expect(report.objects.find((item) => item.name === "loans.loans_interest_period_unit_check")?.state).toBe("compatible");
    expect(report.objects.find((item) => item.name === "loans.loans_tenant_activation_idempotency_unique")?.state).toBe("compatible");
});

test("rejects materially different canonical constraints and indexes", async () => {
    const report = await inspectLoanOriginationSchema(fakeCatalog({
        columns: [
            { table: "loans", name: "activation_idempotency_key", type: "text", nullable: true },
            { table: "loans", name: "activation_result", type: "jsonb", nullable: true },
        ],
        constraints: [
            { table: "loans", name: "loans_interest_period_unit_check", definition: "CHECK (interest_period_unit IS NULL OR interest_period_unit IN ('day', 'month'))" },
        ],
        indexes: [
            { table: "loans", name: "loans_tenant_activation_idempotency_unique", definition: "CREATE UNIQUE INDEX loans_tenant_activation_idempotency_unique ON public.loans USING btree (tenant_id, activation_idempotency_key)", predicate: null },
        ],
    }));

    expect(report.objects.find((item) => item.name === "loans.loans_interest_period_unit_check")?.state).toBe("incompatible");
    expect(report.objects.find((item) => item.name === "loans.loans_tenant_activation_idempotency_unique")?.state).toBe("incompatible");
});

test("rejects the same Boolean operands with different grouping", async () => {
    const report = await inspectLoanOriginationSchema(fakeCatalog({
        constraints: [
            {
                table: "loans",
                name: "loans_interest_period_policy_completeness_check",
                definition: "CHECK (((interest_period_unit IS NULL AND interest_period_length IS NULL AND advance_interest_periods IS NULL AND advance_interest_refund_policy IS NULL) AND (interest_period_anchor_date IS NULL OR interest_period_unit IS NOT NULL)) AND interest_period_length IS NOT NULL AND advance_interest_periods IS NOT NULL AND advance_interest_refund_policy IS NOT NULL AND interest_period_anchor_date IS NOT NULL)",
            },
        ],
    }));

    expect(report.objects.find((item) => item.name === "loans.loans_interest_period_policy_completeness_check")?.state).toBe("incompatible");
});

test("rejects unsupported operators instead of dropping their characters", async () => {
    const report = await inspectLoanOriginationSchema(fakeCatalog({
        constraints: [
            { table: "loans", name: "loans_interest_period_length_check", definition: "CHECK (interest_period_length IS NULL OR interest_period_length != 1)" },
            { table: "loans", name: "loans_interest_period_unit_check", definition: "CHECK (interest_period_unit IS NULL OR interest_period_unit = @1)" },
        ],
    }));

    expect(report.objects.find((item) => item.name === "loans.loans_interest_period_length_check")?.state).toBe("incompatible");
    expect(report.objects.find((item) => item.name === "loans.loans_interest_period_unit_check")?.state).toBe("incompatible");
});

test("bounds PostgreSQL cast recognition to the type name", async () => {
    const report = await inspectLoanOriginationSchema(fakeCatalog({
        constraints: [
            { table: "loans", name: "loans_interest_period_length_check", definition: "CHECK (interest_period_length IS NULL OR interest_period_length = 1::integer AND deliberately_ignored IS NULL)" },
        ],
    }));

    expect(report.objects.find((item) => item.name === "loans.loans_interest_period_length_check")?.state).toBe("incompatible");
});

test("flattens nested associative Boolean groups with the same operator", async () => {
    const report = await inspectLoanOriginationSchema(fakeCatalog({
        constraints: [
            {
                table: "loans",
                name: "loans_interest_period_policy_completeness_check",
                definition: "CHECK (((interest_period_unit IS NULL AND interest_period_length IS NULL) AND advance_interest_periods IS NULL) AND advance_interest_refund_policy IS NULL AND interest_period_anchor_date IS NULL OR (interest_period_unit IS NOT NULL AND interest_period_length IS NOT NULL AND advance_interest_periods IS NOT NULL AND advance_interest_refund_policy IS NOT NULL AND interest_period_anchor_date IS NOT NULL))",
            },
        ],
    }));

    expect(report.objects.find((item) => item.name === "loans.loans_interest_period_policy_completeness_check")?.state).toBe("compatible");
});

test("distinguishes constrained numeric columns from unconstrained numeric columns", async () => {
    const constrained = await inspectLoanOriginationSchema(fakeCatalog({
        columns: [{ table: "loans", name: "single_payment_fixed_agreed_interest", type: "numeric", nullable: true, numericPrecision: 10, numericScale: 2 }],
    }));
    expect(constrained.objects.find((item) => item.name === "loans.single_payment_fixed_agreed_interest")?.state).toBe("incompatible");
});

test("classifies missing and incompatible loan columns without exposing row data", async () => {
    const report = await inspectLoanOriginationSchema(fakeCatalog({
        columns: [
            { table: "loans", name: "activation_idempotency_key", type: "text", nullable: true },
            { table: "loans", name: "activation_result", type: "text", nullable: true },
        ],
    }));

    expect(report.objects.find((item) => item.name === "loans.activation_idempotency_key")?.state).toBe("compatible");
    expect(report.objects.find((item) => item.name === "loans.activation_result")?.state).toBe("incompatible");
    expect(report.objects.find((item) => item.name === "loans.interest_period_unit")?.state).toBe("missing");
    expect(JSON.stringify(report)).not.toContain("borrower");

    const missing = report.objects.filter((item) => item.state === "missing").map((item) => item.name);
    expect(missing).toEqual(expect.arrayContaining([
        "loans.interest_period_unit",
        "loans.interest_period_length",
        "loans.advance_interest_periods",
        "loans.advance_interest_refund_policy",
        "loans.interest_period_anchor_date",
        "loans.single_payment_due_date",
        "loans.single_payment_fixed_agreed_interest",
        "loans.single_payment_interest_policy",
        "loans.single_payment_retroactive_rate_type",
        "loans.single_payment_retroactive_rate",
        "loans.single_payment_late_penalty_mode",
        "loans.single_payment_late_penalty_amount_per_day",
        "loans.single_payment_late_penalty_grace_days",
        "loans.floating_accrual_cycle",
    ]));
});

test("classifies required loan constraints and activation index as missing", async () => {
    const report = await inspectLoanOriginationSchema(fakeCatalog({ columns: [] }));
    const missing = report.objects.filter((item) => item.state === "missing").map((item) => item.name);

    expect(missing).toEqual(expect.arrayContaining([
        "loans.loans_term_months_check",
        "loans.loans_one_funding_source_check",
        "loans.loans_single_payment_terms_check",
        "loans.loans_floating_accrual_cycle_check",
        "loans.loans_single_payment_money_check",
        "loans.loans_interest_period_unit_check",
        "loans.loans_interest_period_length_check",
        "loans.loans_advance_interest_periods_check",
        "loans.loans_advance_interest_refund_policy_check",
        "loans.loans_interest_period_policy_completeness_check",
        "loans.loans_activation_command_completeness_check",
        "loans.loans_tenant_activation_idempotency_unique",
    ]));
});

test("assertCompatibleLoanOriginationSchema fails closed", () => {
    expect(() => assertCompatibleLoanOriginationSchema({ compatible: false, objects: [] })).toThrow();
    expect(() => assertCompatibleLoanOriginationSchema({ compatible: true, objects: [] })).not.toThrow();
});

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
integrationTest("inspects every contract object after applying the current migrations", async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL!;
    const sql = postgres(databaseUrl, { max: 1 });
    try {
        await migrate(drizzle(sql), { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
        const report = await inspectLoanOriginationSchema(sql);
        expect(report.compatible).toBe(true);
        expect(report.objects.every((object) => object.state === "compatible")).toBe(true);
    } finally {
        await sql.end();
    }
});
