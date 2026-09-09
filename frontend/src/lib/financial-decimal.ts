import Decimal from "decimal.js";

// Match the public REST/MCP unsigned-money maxLength 32 contract: 29 integer
// digits, one decimal point, and two fractional digits. Extra precision is
// reserved for intermediate arithmetic, not wider public values.
export const PUBLIC_MONEY_INTEGER_DIGITS = 29;
export const FINANCIAL_DECIMAL_PRECISION = 100;

export const FinancialDecimal = Decimal.clone({
    precision: FINANCIAL_DECIMAL_PRECISION,
    rounding: Decimal.ROUND_HALF_UP,
});

export const unsignedMoneyInputPattern = new RegExp(
    `^\\d{1,${PUBLIC_MONEY_INTEGER_DIGITS}}(?:\\.\\d{1,2})?$`,
);

export const signedMoneyInputPattern = new RegExp(
    `^-?(?:0|[1-9]\\d{0,${PUBLIC_MONEY_INTEGER_DIGITS - 1}})(?:\\.\\d{1,2})?$`,
);

export const signedPublicMoneyPattern = new RegExp(
    `^-?(?:0|[1-9]\\d{0,${PUBLIC_MONEY_INTEGER_DIGITS - 1}})\\.\\d{2}$`,
);
