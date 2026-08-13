import { t } from "elysia";

export const repaymentType = t.Union([t.Literal("daily"), t.Literal("weekly"), t.Literal("monthly"), t.Literal("floating")]);
export const floatingInterestPolicy = t.Object({
    periodUnit: t.Union([t.Literal("day"), t.Literal("week")]),
    periodLength: t.Literal(1),
    rateMode: t.Union([t.Literal("per_thousand"), t.Literal("percent")]),
    rate: t.String(),
    advanceInterestPeriods: t.Union([t.Literal(0), t.Literal(1)]),
    advanceInterestRefundPolicy: t.Literal("non_refundable"),
}, { additionalProperties: t.Never() });
export const dailyEntry = t.Object({ durationUnit: t.Union([t.Literal("days"), t.Literal("months")]), durationValue: t.Integer({ minimum: 1, maximum: 100_000 }), entryMode: t.Union([t.Literal("daily_payment"), t.Literal("daily_interest")]), dailyPayment: t.Optional(t.String()), interestInput: t.Optional(t.Object({ mode: t.Union([t.Literal("percent"), t.Literal("fixed_amount"), t.Literal("per_thousand")]), value: t.String() }, { additionalProperties: t.Never() })) }, { additionalProperties: t.Never() });
export const loanTermsBody = t.Object({ principal: t.String(), interestRate: t.String(), termMonths: t.Number(), repaymentType, startDate: t.String(), totalInstallments: t.Optional(t.Number()), installmentAmount: t.Optional(t.String()), floatingInterestPolicy: t.Optional(floatingInterestPolicy), dailyEntry: t.Optional(dailyEntry) }, { additionalProperties: t.Never() });
