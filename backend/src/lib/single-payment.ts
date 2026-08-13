import Decimal from "decimal.js";
import { parseMoney, serializeMoney } from "./money";

export type RetroactiveInterest = {
    rateType: "percent_per_day" | "per_thousand_per_day";
    rate: string;
};

export type LatePenalty =
    | { mode: "none" }
    | { mode: "fixed_amount_per_day"; amountPerDay: string; graceDays: number };

export interface SinglePaymentTerms {
    dueDate: string;
    fixedAgreedInterest: string;
    interestPolicy: "fixed_only" | "greater_of_fixed_or_retroactive";
    retroactiveInterest?: RetroactiveInterest;
    latePenalty: LatePenalty;
}

export interface SinglePaymentExposure {
    amount: string;
    fromDate: string;
    toDate: string;
}

export interface SinglePaymentSettlementInput {
    settlementDate: string;
    dueDate: string;
    fixedAgreedInterest: string;
    retroactive?: RetroactiveInterest;
    exposures: readonly SinglePaymentExposure[];
    latePenalty: LatePenalty;
    waivers: { interest: string; fees: string; penalties: string };
    outstandingPrincipal?: string;
    outstandingFees?: string;
    externalSettlementCredits?: string;
}

function dateAtBangkokMidnight(value: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Business date must use YYYY-MM-DD");
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new Error("Business date is invalid");
    return date;
}

function calendarDays(fromDate: string, toDate: string): number {
    return Math.round((dateAtBangkokMidnight(toDate).valueOf() - dateAtBangkokMidnight(fromDate).valueOf()) / 86_400_000);
}

function normalizeRetroactiveInterest(input: RetroactiveInterest): RetroactiveInterest {
    if (input.rateType !== "percent_per_day" && input.rateType !== "per_thousand_per_day") throw new Error("Retroactive interest rate type is invalid");
    const rate = new Decimal(input.rate);
    if (!rate.isFinite() || rate.isNegative() || rate.decimalPlaces() > 4) throw new Error("Retroactive interest rate must be a non-negative decimal with at most four places");
    return { rateType: input.rateType, rate: rate.toFixed(4) };
}

function normalizeLatePenalty(input: LatePenalty): LatePenalty {
    if (input.mode === "none") return { mode: "none" };
    if (input.mode !== "fixed_amount_per_day") throw new Error("Late penalty mode is invalid");
    if (!Number.isInteger(input.graceDays) || input.graceDays < 0) throw new Error("Late penalty grace days must be a non-negative whole number");
    return { mode: "fixed_amount_per_day", amountPerDay: serializeMoney(parseMoney(input.amountPerDay)), graceDays: input.graceDays };
}

export function normalizeSinglePaymentTerms(input: SinglePaymentTerms, startDate: string): SinglePaymentTerms {
    if (calendarDays(startDate, input.dueDate) <= 0) throw new Error("Due date must be later than start date");
    const fixedAgreedInterest = serializeMoney(parseMoney(input.fixedAgreedInterest));
    const latePenalty = normalizeLatePenalty(input.latePenalty);
    if (input.interestPolicy === "fixed_only") {
        if (input.retroactiveInterest !== undefined) throw new Error("Fixed-only terms cannot include retroactive interest");
        return { dueDate: input.dueDate, fixedAgreedInterest, interestPolicy: "fixed_only", latePenalty };
    }
    if (input.interestPolicy !== "greater_of_fixed_or_retroactive") throw new Error("Single-payment interest policy is invalid");
    if (!input.retroactiveInterest) throw new Error("Retroactive interest is required");
    return { dueDate: input.dueDate, fixedAgreedInterest, interestPolicy: "greater_of_fixed_or_retroactive", retroactiveInterest: normalizeRetroactiveInterest(input.retroactiveInterest), latePenalty };
}

function normalizeWaiver(value: string, component: Decimal, componentName: string): Decimal {
    const waiver = parseMoney(value);
    if (waiver.gt(component)) throw new Error(`${componentName} waiver cannot exceed its component`);
    return waiver;
}

export function calculateSinglePaymentSettlement(input: SinglePaymentSettlementInput) {
    const settlementDate = dateAtBangkokMidnight(input.settlementDate);
    const dueDate = dateAtBangkokMidnight(input.dueDate);
    const fixedInterest = parseMoney(input.fixedAgreedInterest);
    const retroactive = input.retroactive === undefined ? undefined : normalizeRetroactiveInterest(input.retroactive);
    const exposureTrace = input.exposures.map((exposure) => {
        const amount = parseMoney(exposure.amount);
        const days = calendarDays(exposure.fromDate, exposure.toDate);
        if (days < 0) throw new Error("Exposure end date must not precede its start date");
        if (dateAtBangkokMidnight(exposure.toDate) > settlementDate) throw new Error("Exposure end date must not be after settlement date");
        const dailyRate = retroactive === undefined ? new Decimal(0) : retroactive.rateType === "percent_per_day" ? new Decimal(retroactive.rate).div(100) : new Decimal(retroactive.rate).div(1000);
        const unroundedInterest = amount.times(dailyRate).times(days);
        return { amount: serializeMoney(amount), fromDate: exposure.fromDate, toDate: exposure.toDate, days, rateType: retroactive?.rateType, rate: retroactive?.rate, unroundedInterest: unroundedInterest.toFixed(), roundedInterest: serializeMoney(unroundedInterest), value: unroundedInterest };
    });
    const retroactiveInterest = retroactive === undefined ? new Decimal(0) : exposureTrace.reduce((total, segment) => total.plus(segment.value), new Decimal(0));
    const roundedRetroactiveInterest = retroactiveInterest.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const selectedInterest = Decimal.max(fixedInterest, roundedRetroactiveInterest);
    const selectedInterestBranch = roundedRetroactiveInterest.gt(fixedInterest) ? "retroactive" : "fixed";
    const latePenalty = normalizeLatePenalty(input.latePenalty);
    const lateDays = Math.max(0, Math.round((settlementDate.valueOf() - dueDate.valueOf()) / 86_400_000) - (latePenalty.mode === "none" ? 0 : latePenalty.graceDays));
    const grossPenalty = latePenalty.mode === "none" ? new Decimal(0) : parseMoney(latePenalty.amountPerDay).times(lateDays);
    const outstandingPrincipal = input.outstandingPrincipal === undefined ? new Decimal(0) : parseMoney(input.outstandingPrincipal);
    const outstandingFees = input.outstandingFees === undefined ? new Decimal(0) : parseMoney(input.outstandingFees);
    const externalSettlementCredits = input.externalSettlementCredits === undefined ? new Decimal(0) : parseMoney(input.externalSettlementCredits);
    const waivedInterest = normalizeWaiver(input.waivers.interest, selectedInterest, "Interest");
    const waivedFees = normalizeWaiver(input.waivers.fees, outstandingFees, "Fee");
    const waivedPenalty = normalizeWaiver(input.waivers.penalties, grossPenalty, "Penalty");
    const netInterest = selectedInterest.minus(waivedInterest);
    const netFees = outstandingFees.minus(waivedFees);
    const netPenalty = grossPenalty.minus(waivedPenalty);
    const grossSettlement = outstandingPrincipal.plus(selectedInterest).plus(outstandingFees).plus(grossPenalty);
    const netSettlement = outstandingPrincipal.plus(netInterest).plus(netFees).plus(netPenalty).minus(externalSettlementCredits);
    return {
        fixedInterestCandidate: serializeMoney(fixedInterest), retroactiveInterestCandidate: serializeMoney(roundedRetroactiveInterest), selectedInterest: serializeMoney(selectedInterest), selectedInterestBranch,
        interestDifference: serializeMoney(selectedInterest.minus(Decimal.min(fixedInterest, roundedRetroactiveInterest))),
        exposureTrace: exposureTrace.map(({ value: _value, ...segment }) => segment), lateDays,
        grossPrincipal: serializeMoney(outstandingPrincipal), grossInterest: serializeMoney(selectedInterest), grossFees: serializeMoney(outstandingFees), grossPenalty: serializeMoney(grossPenalty), grossSettlement: serializeMoney(grossSettlement),
        waivedInterest: serializeMoney(waivedInterest), waivedFees: serializeMoney(waivedFees), waivedPenalty: serializeMoney(waivedPenalty),
        netInterest: serializeMoney(netInterest), netFees: serializeMoney(netFees), netPenalty: serializeMoney(netPenalty), externalSettlementCredits: serializeMoney(externalSettlementCredits), netSettlement: serializeMoney(netSettlement),
    };
}
