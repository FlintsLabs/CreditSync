import { t } from "elysia";

export const publicMoney = t.String({ pattern: "^(0|[1-9]\\d*)\\.\\d{2}$", maxLength: 32 });
const publicRate = t.String({ pattern: "^\\d+(?:\\.\\d{1,4})?$", maxLength: 32 });
export const repaymentType = t.Union([t.Literal("daily"), t.Literal("weekly"), t.Literal("monthly"), t.Literal("floating")]);
export const floatingInterestPolicy = t.Object({
    periodUnit: t.Union([t.Literal("day"), t.Literal("week")]),
    periodLength: t.Literal(1),
    rateMode: t.Union([t.Literal("per_thousand"), t.Literal("percent")]),
    rate: publicRate,
    advanceInterestPeriods: t.Union([t.Literal(0), t.Literal(1)]),
    advanceInterestRefundPolicy: t.Literal("non_refundable"),
}, { additionalProperties: t.Never() });
export const dailyEntry = t.Object({ durationUnit: t.Union([t.Literal("days"), t.Literal("months")]), durationValue: t.Integer({ minimum: 1, maximum: 100_000 }), entryMode: t.Union([t.Literal("daily_payment"), t.Literal("daily_interest")]), dailyPayment: t.Optional(publicMoney), interestInput: t.Optional(t.Object({ mode: t.Union([t.Literal("percent"), t.Literal("fixed_amount"), t.Literal("per_thousand")]), value: publicRate }, { additionalProperties: t.Never() })) }, { additionalProperties: t.Never() });
export const loanTermsBody = t.Object({ principal: publicMoney, interestRate: publicMoney, termMonths: t.Number(), repaymentType, startDate: t.String(), totalInstallments: t.Optional(t.Number()), installmentAmount: t.Optional(publicMoney), floatingInterestPolicy: t.Optional(floatingInterestPolicy), dailyEntry: t.Optional(dailyEntry) }, { additionalProperties: t.Never() });
