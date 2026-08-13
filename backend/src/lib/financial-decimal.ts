import Decimal from "decimal.js";

// PostgreSQL numeric columns are unconstrained. Public money is deliberately
// bounded so every accepted value and intermediate cent calculation stays
// comfortably within this isolated Decimal context.
export const PUBLIC_MONEY_INTEGER_DIGITS = 80;
export const FINANCIAL_DECIMAL_PRECISION = 100;

export const FinancialDecimal = Decimal.clone({
    precision: FINANCIAL_DECIMAL_PRECISION,
    rounding: Decimal.ROUND_HALF_UP,
});

export const unsignedPublicMoneyPattern = new RegExp(
    `^\\d{1,${PUBLIC_MONEY_INTEGER_DIGITS}}\\.\\d{2}$`,
);

export const signedPublicMoneyPattern = new RegExp(
    `^-?\\d{1,${PUBLIC_MONEY_INTEGER_DIGITS}}\\.\\d{2}$`,
);
