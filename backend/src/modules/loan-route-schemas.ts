import { t } from "elysia";

const preserveUnknown = { additionalProperties: true } as const;

export const publicMoney = t.String({ pattern: "^(0|[1-9]\\d*)\\.\\d{2}$", maxLength: 32 });
export const repaymentType = t.Union([
    t.Literal("single_payment"),
    t.Literal("daily"),
    t.Literal("weekly"),
    t.Literal("monthly"),
    t.Literal("floating"),
]);

export const floatingInterestPolicy = t.Object({
    periodUnit: t.Union([t.Literal("day"), t.Literal("week")]),
    periodLength: t.Literal(1),
    rateMode: t.Union([t.Literal("per_thousand"), t.Literal("percent")]),
    rate: t.String(),
    advanceInterestPeriods: t.Union([t.Literal(0), t.Literal(1)]),
    advanceInterestRefundPolicy: t.Literal("non_refundable"),
}, preserveUnknown);

export const floatingDailyInterest = t.Object({
    mode: t.Union([t.Literal("per_thousand"), t.Literal("percent")]),
    rate: t.String(),
    firstDayTreatment: t.Union([t.Literal("deduct"), t.Literal("start_next_day")]),
    accrualCycle: t.Optional(t.Union([t.Literal("daily"), t.Literal("weekly")])),
}, preserveUnknown);

export const dailyEntry = t.Object({
    durationUnit: t.Union([t.Literal("days"), t.Literal("months")]),
    durationValue: t.Integer({ minimum: 1, maximum: 100_000 }),
    entryMode: t.Union([t.Literal("daily_payment"), t.Literal("daily_interest")]),
    dailyPayment: t.Optional(t.String()),
    interestInput: t.Optional(t.Object({
        mode: t.Union([t.Literal("percent"), t.Literal("fixed_amount"), t.Literal("per_thousand")]),
        value: t.String(),
    }, preserveUnknown)),
}, preserveUnknown);

export const singlePayment = t.Object({
    dueDate: t.String(),
    fixedAgreedInterest: t.String(),
    interestPolicy: t.Union([t.Literal("fixed_only"), t.Literal("greater_of_fixed_or_retroactive")]),
    retroactiveInterest: t.Optional(t.Object({
        rateType: t.Union([t.Literal("percent_per_day"), t.Literal("per_thousand_per_day")]),
        rate: t.String(),
    }, preserveUnknown)),
    latePenalty: t.Union([
        t.Object({ mode: t.Literal("none") }, preserveUnknown),
        t.Object({
            mode: t.Literal("fixed_amount_per_day"),
            amountPerDay: t.String(),
            graceDays: t.Integer({ minimum: 0 }),
        }, preserveUnknown),
    ]),
}, preserveUnknown);

export const loanTermsBody = t.Object({
    principal: publicMoney,
    interestRate: publicMoney,
    termMonths: t.Number(),
    repaymentType,
    startDate: t.String(),
    totalInstallments: t.Optional(t.Number()),
    installmentAmount: t.Optional(publicMoney),
    floatingInterestPolicy: t.Optional(floatingInterestPolicy),
    floatingDailyInterest: t.Optional(floatingDailyInterest),
    dailyEntry: t.Optional(dailyEntry),
    singlePayment: t.Optional(singlePayment),
}, preserveUnknown);

export const loanDraftBody = t.Composite([
    loanTermsBody,
    t.Object({
        borrowerPublicId: t.String(),
        bankLoanPublicId: t.Optional(t.Nullable(t.String())),
        bankProfilePublicId: t.Optional(t.Nullable(t.String())),
    }, preserveUnknown),
], preserveUnknown);

export const loanDraftUpdateBody = t.Partial(loanDraftBody);
