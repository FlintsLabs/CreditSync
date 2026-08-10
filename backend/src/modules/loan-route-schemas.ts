import { t } from "elysia";

export const repaymentType = t.Union([t.Literal("daily"), t.Literal("weekly"), t.Literal("monthly"), t.Literal("floating")]);
export const floatingDailyInterest = t.Object({ mode: t.Union([t.Literal("per_thousand"), t.Literal("percent")]), rate: t.String(), firstDayTreatment: t.Union([t.Literal("deduct"), t.Literal("start_next_day")]) });
export const dailyEntry = t.Object({ durationUnit: t.Union([t.Literal("days"), t.Literal("months")]), durationValue: t.Integer({ minimum: 1, maximum: 100_000 }), entryMode: t.Union([t.Literal("daily_payment"), t.Literal("daily_interest")]), dailyPayment: t.Optional(t.String()), interestInput: t.Optional(t.Object({ mode: t.Union([t.Literal("percent"), t.Literal("fixed_amount"), t.Literal("per_thousand")]), value: t.String() })) });
export const loanTermsBody = t.Object({ principal: t.String(), interestRate: t.String(), termMonths: t.Number(), repaymentType, startDate: t.String(), totalInstallments: t.Optional(t.Number()), installmentAmount: t.Optional(t.String()), floatingDailyInterest: t.Optional(floatingDailyInterest), dailyEntry: t.Optional(dailyEntry) });
