import Decimal from "decimal.js";

// The public REST/MCP unsigned-money contract is maxLength 32:
// 29 integer digits, one decimal point, and two fractional digits. Signed
// outputs use maxLength 33. Keep extra precision only for intermediate math.
export const PUBLIC_MONEY_INTEGER_DIGITS = 29;
export const FINANCIAL_DECIMAL_PRECISION = 100;

export const FinancialDecimal = Decimal.clone({
    precision: FINANCIAL_DECIMAL_PRECISION,
    rounding: Decimal.ROUND_HALF_UP,
});

export const unsignedPublicMoneyPattern = new RegExp(
    `^(?:0|[1-9]\\d{0,${PUBLIC_MONEY_INTEGER_DIGITS - 1}})\\.\\d{2}$`,
);

export const signedPublicMoneyPattern = new RegExp(
    `^-?(?:0|[1-9]\\d{0,${PUBLIC_MONEY_INTEGER_DIGITS - 1}})\\.\\d{2}$`,
);
