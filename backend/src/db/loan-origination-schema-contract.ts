export type SchemaObjectState = "compatible" | "missing" | "incompatible";

export type SchemaObjectResult = {
    kind: "column" | "constraint" | "index";
    name: string;
    state: SchemaObjectState;
    expected: string;
    actual: string | null;
};

export type LoanOriginationSchemaReport = {
    compatible: boolean;
    objects: SchemaObjectResult[];
};

export type SchemaCatalogExecutor = (
    strings: TemplateStringsArray,
    ...values: unknown[]
) => unknown;

type ColumnCatalogRow = { table_name?: string; column_name?: string; data_type?: string; is_nullable?: string; numeric_precision?: number | null; numeric_scale?: number | null; table?: string; name?: string; type?: string; nullable?: boolean; numericPrecision?: number | null; numericScale?: number | null };
type ConstraintCatalogRow = { conname?: string; definition: string; table?: string; name?: string };
type IndexCatalogRow = { tablename?: string; indexname?: string; indexdef?: string; predicate?: string | null; table?: string; name?: string; definition?: string };

type ContractEntry = {
    kind: SchemaObjectResult["kind"];
    name: string;
    expected: string;
    actualKey: string;
};

const column = (name: string, type: string): ContractEntry => ({
    kind: "column",
    name: `loans.${name}`,
    expected: `${type}, nullable`,
    actualKey: name,
});

const check = (name: string, definition: string): ContractEntry => ({
    kind: "constraint",
    name: `loans.${name}`,
    expected: definition,
    actualKey: name,
});

const index = (name: string, definition: string, predicate: string): ContractEntry => ({
    kind: "index",
    name: `loans.${name}`,
    expected: `${definition} WHERE ${predicate}`,
    actualKey: name,
});

const loanColumns: ContractEntry[] = [
    column("interest_period_unit", "text"),
    column("interest_period_length", "integer"),
    column("advance_interest_periods", "integer"),
    column("advance_interest_refund_policy", "text"),
    column("interest_period_anchor_date", "date"),
    column("single_payment_due_date", "date"),
    column("single_payment_fixed_agreed_interest", "numeric"),
    column("single_payment_interest_policy", "text"),
    column("single_payment_retroactive_rate_type", "text"),
    column("single_payment_retroactive_rate", "numeric"),
    column("single_payment_late_penalty_mode", "text"),
    column("single_payment_late_penalty_amount_per_day", "numeric"),
    column("single_payment_late_penalty_grace_days", "integer"),
    column("floating_accrual_cycle", "text"),
    column("activation_idempotency_key", "text"),
    column("activation_result", "jsonb"),
];

const loanConstraints: ContractEntry[] = [
    check("loans_term_months_check", `CHECK (term_months IS NULL OR term_months > 0)`),
    check("loans_one_funding_source_check", `CHECK (bank_loan_id IS NULL OR funding_bank_profile_id IS NULL)`),
    check("loans_single_payment_terms_check", `CHECK ((repayment_type <> 'single_payment' AND single_payment_due_date IS NULL AND single_payment_fixed_agreed_interest IS NULL AND single_payment_interest_policy IS NULL AND single_payment_retroactive_rate_type IS NULL AND single_payment_retroactive_rate IS NULL AND single_payment_late_penalty_mode IS NULL AND single_payment_late_penalty_amount_per_day IS NULL AND single_payment_late_penalty_grace_days IS NULL) OR (repayment_type = 'single_payment' AND start_date IS NOT NULL AND single_payment_due_date > start_date AND single_payment_fixed_agreed_interest IS NOT NULL AND ((single_payment_interest_policy = 'fixed_only' AND single_payment_retroactive_rate_type IS NULL AND single_payment_retroactive_rate IS NULL) OR (single_payment_interest_policy = 'greater_of_fixed_or_retroactive' AND single_payment_retroactive_rate_type IN ('percent_per_day', 'per_thousand_per_day') AND single_payment_retroactive_rate IS NOT NULL)) AND ((single_payment_late_penalty_mode = 'none' AND single_payment_late_penalty_amount_per_day IS NULL AND single_payment_late_penalty_grace_days IS NULL) OR (single_payment_late_penalty_mode = 'fixed_amount_per_day' AND single_payment_late_penalty_amount_per_day IS NOT NULL AND single_payment_late_penalty_grace_days >= 0))))`),
    check("loans_floating_accrual_cycle_check", `CHECK ((repayment_type = 'floating' AND floating_accrual_cycle IN ('daily', 'weekly')) OR (repayment_type <> 'floating' AND floating_accrual_cycle IS NULL))`),
    check("loans_single_payment_money_check", `CHECK ((single_payment_fixed_agreed_interest IS NULL OR (single_payment_fixed_agreed_interest >= 0 AND scale(single_payment_fixed_agreed_interest) <= 2)) AND (single_payment_retroactive_rate IS NULL OR (single_payment_retroactive_rate >= 0 AND scale(single_payment_retroactive_rate) <= 4)) AND (single_payment_late_penalty_amount_per_day IS NULL OR (single_payment_late_penalty_amount_per_day >= 0 AND scale(single_payment_late_penalty_amount_per_day) <= 2)))`),
    check("loans_interest_period_unit_check", `CHECK (interest_period_unit IS NULL OR interest_period_unit IN ('day', 'week'))`),
    check("loans_interest_period_length_check", `CHECK (interest_period_length IS NULL OR interest_period_length = 1)`),
    check("loans_advance_interest_periods_check", `CHECK (advance_interest_periods IS NULL OR advance_interest_periods IN (0, 1))`),
    check("loans_advance_interest_refund_policy_check", `CHECK (advance_interest_refund_policy IS NULL OR advance_interest_refund_policy = 'non_refundable')`),
    check("loans_interest_period_policy_completeness_check", `CHECK ((interest_period_unit IS NULL AND interest_period_length IS NULL AND advance_interest_periods IS NULL AND advance_interest_refund_policy IS NULL AND interest_period_anchor_date IS NULL) OR (interest_period_unit IS NOT NULL AND interest_period_length IS NOT NULL AND advance_interest_periods IS NOT NULL AND advance_interest_refund_policy IS NOT NULL AND interest_period_anchor_date IS NOT NULL))`),
    check("loans_activation_command_completeness_check", `CHECK ((activation_idempotency_key IS NULL AND activation_result IS NULL) OR (activation_idempotency_key IS NOT NULL AND activation_result IS NOT NULL))`),
];

const loanIndex = index(
    "loans_tenant_activation_idempotency_unique",
    `CREATE UNIQUE INDEX loans_tenant_activation_idempotency_unique ON loans USING btree (tenant_id, activation_idempotency_key)`,
    `activation_idempotency_key IS NOT NULL`,
);

export const LOAN_ORIGINATION_SCHEMA_CONTRACT = [...loanColumns, ...loanConstraints, loanIndex] as const;

const normalizeSql = (value: string): string => value
    .toLowerCase()
    .replaceAll('"', "")
    .replaceAll("public.", "")
    .replaceAll("loans.", "")
    .replace(/::[a-z_ ]+/g, "")
    .replace(/=\s*any\s*\(\s*array\s*\[([^\]]+)\]\s*\)/g, "in ($1)")
    .replace(/\bwhere\s*\(([^()]*)\)\s*$/g, "where $1")
    .replace(/\s+/g, " ")
    .replace(/\(([^()]*\s(?:is null|is not null|<>|>=|<=|=|>)\s*[^()]*)\)/g, "$1")
    .trim();

const normalizeConstraint = (value: string): string => {
    let normalized = normalizeSql(value);
    normalized = normalized.replace(/\bin\s*\(([^()]*)\)/g, "in $1");
    return normalized.replaceAll("(", "").replaceAll(")", "").replace(/\s+/g, " ").trim();
};

const classify = (entry: ContractEntry, actual: string | null): SchemaObjectResult => ({
    ...entry,
    state: actual === null ? "missing" : (entry.kind === "constraint" ? normalizeConstraint(actual) : normalizeSql(actual)) === (entry.kind === "constraint" ? normalizeConstraint(entry.expected) : normalizeSql(entry.expected)) ? "compatible" : "incompatible",
    actual,
});

export async function inspectLoanOriginationSchema(executor: SchemaCatalogExecutor): Promise<LoanOriginationSchemaReport> {
    const columns = (await executor`
        SELECT table_name, column_name, data_type, is_nullable, numeric_precision, numeric_scale
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'loans'
    `) as ColumnCatalogRow[];
    const constraints = (await executor`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.loans'::regclass
    `) as ConstraintCatalogRow[];
    const indexes = (await executor`
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'loans'
    `) as IndexCatalogRow[];
    await executor`
        SELECT hash, created_at
        FROM drizzle.__drizzle_migrations
        ORDER BY created_at DESC
        LIMIT 1
    `;

    const columnMap = new Map(columns.map((row) => {
        const name = row.column_name ?? row.name!;
        const type = row.data_type ?? row.type!;
        const nullable = row.is_nullable ? row.is_nullable === "YES" : row.nullable === true;
        const precision = row.numeric_precision ?? row.numericPrecision;
        const scale = row.numeric_scale ?? row.numericScale;
        const typeDescription = type === "numeric" && (precision !== null && precision !== undefined || scale !== null && scale !== undefined)
            ? `numeric(${precision ?? ""},${scale ?? ""})`
            : type;
        return [name, `${typeDescription}, ${nullable ? "nullable" : "not nullable"}`];
    }));
    const constraintMap = new Map(constraints.map((row) => [row.conname ?? row.name!, row.definition]));
    const indexMap = new Map(indexes.map((row) => [row.indexname ?? row.name!, row.indexdef ?? row.definition ?? (row.predicate ? `WHERE ${row.predicate}` : "")]));
    const objects = [...loanColumns, ...loanConstraints, loanIndex].map((entry) => {
        const actual = entry.kind === "column" ? columnMap.get(entry.actualKey) ?? null : entry.kind === "constraint" ? constraintMap.get(entry.actualKey) ?? null : indexMap.get(entry.actualKey) ?? null;
        return classify(entry, actual);
    });

    return { compatible: objects.every((object) => object.state === "compatible"), objects };
}

export function assertCompatibleLoanOriginationSchema(report: LoanOriginationSchemaReport): void {
    if (!report.compatible || report.objects.some((object) => object.state !== "compatible")) {
        const failures = report.objects.filter((object) => object.state !== "compatible").map((object) => `${object.name}: ${object.state}`);
        throw new Error(`Loan origination schema is not compatible${failures.length ? ` (${failures.join(", ")})` : ""}`);
    }
}
