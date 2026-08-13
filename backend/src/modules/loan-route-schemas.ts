import { t } from "elysia";

export const repaymentType = t.Union([t.Literal("single_payment"), t.Literal("daily"), t.Literal("weekly"), t.Literal("monthly"), t.Literal("floating")]);
export const floatingDailyInterest = t.Object({
    mode: t.Union([t.Literal("per_thousand"), t.Literal("percent")]),
    rate: t.String(),
    firstDayTreatment: t.Union([t.Literal("deduct"), t.Literal("start_next_day")]),
    accrualCycle: t.Optional(t.Union([t.Literal("daily"), t.Literal("weekly")])),
}, { additionalProperties: true });
export const dailyEntry = t.Object({ durationUnit: t.Union([t.Literal("days"), t.Literal("months")]), durationValue: t.Integer({ minimum: 1, maximum: 100_000 }), entryMode: t.Union([t.Literal("daily_payment"), t.Literal("daily_interest")]), dailyPayment: t.Optional(t.String()), interestInput: t.Optional(t.Object({ mode: t.Union([t.Literal("percent"), t.Literal("fixed_amount"), t.Literal("per_thousand")]), value: t.String() }, { additionalProperties: true })) }, { additionalProperties: true });
export const singlePayment = t.Object({
    dueDate: t.String(),
    fixedAgreedInterest: t.String(),
    interestPolicy: t.Union([t.Literal("fixed_only"), t.Literal("greater_of_fixed_or_retroactive")]),
    retroactiveInterest: t.Optional(t.Object({
        rateType: t.Union([t.Literal("percent_per_day"), t.Literal("per_thousand_per_day")]),
        rate: t.String(),
    }, { additionalProperties: true })),
    latePenalty: t.Union([
        t.Object({ mode: t.Literal("none") }, { additionalProperties: true }),
        t.Object({
            mode: t.Literal("fixed_amount_per_day"),
            amountPerDay: t.String(),
            graceDays: t.Integer({ minimum: 0 }),
        }, { additionalProperties: true }),
    ]),
}, { additionalProperties: true });
export const loanTermsBody = t.Object({
    principal: t.String(),
    interestRate: t.String(),
    termMonths: t.Number(),
    repaymentType,
    startDate: t.String(),
    totalInstallments: t.Optional(t.Number()),
    installmentAmount: t.Optional(t.String()),
    floatingDailyInterest: t.Optional(floatingDailyInterest),
    dailyEntry: t.Optional(dailyEntry),
    singlePayment: t.Optional(singlePayment),
}, { additionalProperties: true });
export const loanDraftBody = t.Composite([
    loanTermsBody,
    t.Object({
        borrowerPublicId: t.String(),
        bankLoanPublicId: t.Optional(t.Nullable(t.String())),
        bankProfilePublicId: t.Optional(t.Nullable(t.String())),
    }, { additionalProperties: true }),
], { additionalProperties: true });
export const loanDraftUpdateBody = t.Partial(loanDraftBody);
