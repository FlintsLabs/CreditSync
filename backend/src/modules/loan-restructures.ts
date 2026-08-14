import { Elysia, t } from "elysia";
import { invalidateTenantCache } from "../lib/cache";
import { authPlugin } from "../middleware/auth";
import { DomainError } from "../services/domain-error";
import { executeLoanRestructure, getLoanRestructure, listLoanRestructures, previewLoanRestructure, reverseLoanRestructure, type PreviewLoanRestructureInput } from "../services/loan-restructure-service";
import { loanCommandContext, loanDomainFailure, loanUnauthorized } from "./loan-http-support";
import { repaymentType } from "./loan-route-schemas";

const strict = { additionalProperties: false } as const;
const preserveUnknown = { additionalProperties: true } as const;
const floatingDailyInterest = t.Object({
    mode: t.Union([t.Literal("per_thousand"), t.Literal("percent")]), rate: t.String(),
    firstDayTreatment: t.Union([t.Literal("deduct"), t.Literal("start_next_day")]),
    accrualCycle: t.Optional(t.Union([t.Literal("daily"), t.Literal("weekly")])),
}, preserveUnknown);
const dailyEntry = t.Object({
    durationUnit: t.Union([t.Literal("days"), t.Literal("months")]), durationValue: t.Integer({ minimum: 1, maximum: 100_000 }),
    entryMode: t.Union([t.Literal("daily_payment"), t.Literal("daily_interest")]), dailyPayment: t.Optional(t.String()),
    interestInput: t.Optional(t.Object({ mode: t.Union([t.Literal("percent"), t.Literal("fixed_amount"), t.Literal("per_thousand")]), value: t.String() }, preserveUnknown)),
}, preserveUnknown);
const singlePayment = t.Object({
    dueDate: t.String(), fixedAgreedInterest: t.String(),
    interestPolicy: t.Union([t.Literal("fixed_only"), t.Literal("greater_of_fixed_or_retroactive")]),
    retroactiveInterest: t.Optional(t.Object({ rateType: t.Union([t.Literal("percent_per_day"), t.Literal("per_thousand_per_day")]), rate: t.String() }, preserveUnknown)),
    latePenalty: t.Union([
        t.Object({ mode: t.Literal("none") }, preserveUnknown),
        t.Object({ mode: t.Literal("fixed_amount_per_day"), amountPerDay: t.String(), graceDays: t.Integer({ minimum: 0 }) }, preserveUnknown),
    ]),
}, preserveUnknown);
const replacementTerms = t.Object({
    interestRate: t.String(), termMonths: t.Number(), repaymentType, startDate: t.String(),
    totalInstallments: t.Optional(t.Number()), installmentAmount: t.Optional(t.String()),
    floatingDailyInterest: t.Optional(floatingDailyInterest), dailyEntry: t.Optional(dailyEntry), singlePayment: t.Optional(singlePayment),
}, preserveUnknown);
const waiver = t.Object({ amount: t.String(), reason: t.String() }, preserveUnknown);

function validationFailure(set: { status?: number | string }) {
    return loanDomainFailure(new DomainError("VALIDATION_ERROR", "Request body contains invalid or unknown fields", 422), set);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
    const unexpectedFields = Object.keys(value).filter(key => !allowed.includes(key)).map(key => `${path}.${key}`);
    if (unexpectedFields.length) throw new DomainError("VALIDATION_ERROR", "Request body contains unknown fields", 422, { unexpectedFields });
}

function assertClosedReplacementInput(body: Record<string, unknown>) {
    assertKnownKeys(body, ["settlementDate", "replacementTerms", "waivers", "externalSettlementCredit", "additionalPrincipal", "reason"], "body");
    const terms = body.replacementTerms as Record<string, unknown>;
    assertKnownKeys(terms, ["interestRate", "termMonths", "repaymentType", "startDate", "totalInstallments", "installmentAmount", "floatingDailyInterest", "dailyEntry", "singlePayment"], "body.replacementTerms");
    const floating = terms.floatingDailyInterest as Record<string, unknown> | undefined;
    if (floating) assertKnownKeys(floating, ["mode", "rate", "firstDayTreatment", "accrualCycle"], "body.replacementTerms.floatingDailyInterest");
    const daily = terms.dailyEntry as Record<string, unknown> | undefined;
    if (daily) {
        assertKnownKeys(daily, ["durationUnit", "durationValue", "entryMode", "dailyPayment", "interestInput"], "body.replacementTerms.dailyEntry");
        const input = daily.interestInput as Record<string, unknown> | undefined;
        if (input) assertKnownKeys(input, ["mode", "value"], "body.replacementTerms.dailyEntry.interestInput");
    }
    const single = terms.singlePayment as Record<string, unknown> | undefined;
    if (single) {
        assertKnownKeys(single, ["dueDate", "fixedAgreedInterest", "interestPolicy", "retroactiveInterest", "latePenalty"], "body.replacementTerms.singlePayment");
        const retroactive = single.retroactiveInterest as Record<string, unknown> | undefined;
        if (retroactive) assertKnownKeys(retroactive, ["rateType", "rate"], "body.replacementTerms.singlePayment.retroactiveInterest");
        const penalty = single.latePenalty as Record<string, unknown> | undefined;
        if (penalty) assertKnownKeys(penalty, penalty.mode === "fixed_amount_per_day" ? ["mode", "amountPerDay", "graceDays"] : ["mode"], "body.replacementTerms.singlePayment.latePenalty");
    }
    const waivers = body.waivers as Record<string, unknown> | undefined;
    if (waivers) {
        assertKnownKeys(waivers, ["interest", "fees", "penalty"], "body.waivers");
        for (const key of ["interest", "fees", "penalty"] as const) {
            const item = waivers[key] as Record<string, unknown> | undefined;
            if (item) assertKnownKeys(item, ["amount", "reason"], `body.waivers.${key}`);
        }
    }
    const credit = body.externalSettlementCredit as Record<string, unknown> | undefined;
    if (credit) assertKnownKeys(credit, ["amount", "payer", "source"], "body.externalSettlementCredit");
}

export const loanRestructureRoutes = new Elysia({ normalize: false })
    .use(authPlugin)
    .onError(({ code, set }) => code === "VALIDATION" ? validationFailure(set) : undefined)
    .get("/:id/restructures", async ({ params, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try { return await listLoanRestructures(loanCommandContext(user, request), params.id); }
        catch (error) { return loanDomainFailure(error, set); }
    }, { params: t.Object({ id: t.String() }, strict) })
    .get("/restructures/:restructureId", async ({ params, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try { return await getLoanRestructure(loanCommandContext(user, request), params.restructureId); }
        catch (error) { return loanDomainFailure(error, set); }
    }, { params: t.Object({ restructureId: t.String() }, strict) })
    .post("/:id/restructures/preview", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertClosedReplacementInput(body as unknown as Record<string, unknown>);
            return await previewLoanRestructure(loanCommandContext(user, request), params.id, body as PreviewLoanRestructureInput);
        }
        catch (error) { return loanDomainFailure(error, set); }
    }, {
        params: t.Object({ id: t.String() }, strict),
        body: t.Object({
            settlementDate: t.String(), replacementTerms,
            waivers: t.Optional(t.Object({ interest: t.Optional(waiver), fees: t.Optional(waiver), penalty: t.Optional(waiver) }, preserveUnknown)),
            externalSettlementCredit: t.Optional(t.Object({ amount: t.String(), payer: t.String(), source: t.String() }, preserveUnknown)),
            additionalPrincipal: t.String(), reason: t.String(),
        }, preserveUnknown),
    })
    .post("/restructures/:restructureId/execute", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertKnownKeys(body as unknown as Record<string, unknown>, ["confirmed", "previewHash", "expectedBalanceVersion", "reason"], "body");
            const result = await executeLoanRestructure(loanCommandContext(user, request), params.restructureId, body);
            await invalidateTenantCache(user.tenantId);
            return result;
        } catch (error) { return loanDomainFailure(error, set); }
    }, {
        params: t.Object({ restructureId: t.String() }, strict),
        body: t.Object({ confirmed: t.Boolean(), previewHash: t.String(), expectedBalanceVersion: t.String(), reason: t.String() }, preserveUnknown),
    })
    .post("/restructures/:restructureId/reverse", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertKnownKeys(body as unknown as Record<string, unknown>, ["reason"], "body");
            const result = await reverseLoanRestructure(loanCommandContext(user, request), params.restructureId, body);
            await invalidateTenantCache(user.tenantId);
            return result;
        } catch (error) { return loanDomainFailure(error, set); }
    }, { params: t.Object({ restructureId: t.String() }, strict), body: t.Object({ reason: t.String() }, preserveUnknown) });
