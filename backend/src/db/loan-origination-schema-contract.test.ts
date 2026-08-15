import { expect, test } from "bun:test";
import {
    assertCompatibleLoanOriginationSchema,
    inspectLoanOriginationSchema,
    type SchemaCatalogExecutor,
} from "./loan-origination-schema-contract";

type Catalog = {
    columns?: Array<{ table: string; name: string; type: string; nullable: boolean }>;
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
