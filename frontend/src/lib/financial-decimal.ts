import Decimal from "decimal.js";

// Keep this isolated from decimal.js's global constructor. Public money is
// bounded to 80 integer digits; 100 significant digits preserves cents and
// leaves headroom for carry during the view-model calculations.
export const PUBLIC_MONEY_INTEGER_DIGITS = 80;
export const FINANCIAL_DECIMAL_PRECISION = 100;

export const FinancialDecimal = Decimal.clone({
    precision: FINANCIAL_DECIMAL_PRECISION,
    rounding: Decimal.ROUND_HALF_UP,
});

export const unsignedMoneyInputPattern = new RegExp(
    `^\\d{1,${PUBLIC_MONEY_INTEGER_DIGITS}}(?:\\.\\d{1,2})?$`,
);

export const signedMoneyInputPattern = new RegExp(
    `^-?\\d{1,${PUBLIC_MONEY_INTEGER_DIGITS}}(?:\\.\\d{1,2})?$`,
);
