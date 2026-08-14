import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRightLeft, CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { normalizeMoney } from "../../../lib/workflow-api";
import { buildLoanTermsInput, formatMoneyExact, type LoanTermsForm } from "../../../lib/workflow-model";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";

interface RestructurableLoan { publicId: string; status: string; repaymentType: string; principalAmount: string }
interface ScheduleRow { installmentNo: number; dueDate: string; amount: string; principalComponent: string; interestComponent: string }
interface Preview {
    publicId: string; status: string; settlementDate: string; oldBalanceVersion: string; previewHash: string; expiresAt: string;
    balance: Record<string, string | number | ExposureTrace[]>; replacementPrincipal: string; schedule: ScheduleRow[];
    externalCreditAllocation: { principal: string; interest: string; fee: string; penalty: string; unallocated: string };
    cash: { direction: "payout" | "collection" | "none"; amount: string }; reason: string;
}
interface ExposureTrace { amount: string; fromDate: string; toDate: string; days: number; rateType?: "percent_per_day" | "per_thousand_per_day"; rate?: string; unroundedInterest: string; roundedInterest: string }

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const emptyToMoney = (value: string) => normalizeMoney(value.trim() || "0");
const hasPositiveAmount = (value: string) => /[1-9]/.test(value);

export function LoanRestructurePanel({ loan, onExecuted }: { loan: RestructurableLoan; onExecuted?: () => void }) {
    const { t, i18n } = useTranslation();
    const [form, setForm] = useState({
        settlementDate: today(), reason: "", additionalPrincipal: "", interestWaiver: "", interestWaiverReason: "", feeWaiver: "", feeWaiverReason: "", penaltyWaiver: "", penaltyWaiverReason: "",
        externalAmount: "", externalPayer: "", externalSource: "", replacementType: "monthly", interestRate: "12", termMonths: "12", startDate: today(), totalInstallments: "", installmentAmount: "",
        dailyDurationUnit: "days" as "days" | "months", dailyDurationValue: "30", dailyEntryMode: "daily_payment" as "daily_payment" | "daily_interest", dailyPayment: "", dailyInterestInputMode: "percent" as "percent" | "fixed_amount" | "per_thousand", dailyInterestInputValue: "",
        floatingMode: "percent" as "percent" | "per_thousand", floatingRate: "", floatingAccrualCycle: "daily" as "daily" | "weekly", firstDayTreatment: "start_next_day" as "deduct" | "start_next_day",
        singleDueDate: "", singleFixedInterest: "", singlePolicy: "fixed_only" as "fixed_only" | "greater_of_fixed_or_retroactive", singleRetroType: "percent_per_day" as "percent_per_day" | "per_thousand_per_day", singleRetroRate: "", singlePenaltyMode: "none" as "none" | "fixed_amount_per_day", singlePenaltyAmount: "", singlePenaltyGrace: "0",
    });
    const [preview, setPreview] = useState<Preview | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState<{ newLoanPublicId: string; disbursementDraftPublicId?: string | null } | null>(null);
    const [previewExpired, setPreviewExpired] = useState(false);
    const errorRef = useRef<HTMLDivElement>(null);
    const previewRef = useRef<HTMLDivElement>(null);
    const intentKey = useRef(crypto.randomUUID());
    const money = useCallback((value: string) => formatMoneyExact(value, i18n.language), [i18n.language]);
    const date = useCallback((value: string) => new Intl.DateTimeFormat(i18n.language).format(new Date(`${value}T00:00:00`)), [i18n.language]);
    const rateType = useCallback((value: ExposureTrace["rateType"]) => t(`restructure.rateTypes.${value ?? "none"}`), [t]);
    const expired = Boolean(preview && previewExpired);
    useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
    useEffect(() => {
        if (!preview || previewExpired || result) return;
        let timer: ReturnType<typeof setTimeout>;
        const scheduleExpiry = () => {
            const remaining = new Date(preview.expiresAt).getTime() - Date.now();
            if (remaining <= 0) {
                setPreviewExpired(true);
                setConfirmed(false);
                setError(t("restructure.errors.expired"));
                return;
            }
            timer = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
        };
        scheduleExpiry();
        return () => clearTimeout(timer);
    }, [preview, previewExpired, result, t]);

    const update = (name: string, value: string) => { setForm(current => ({ ...current, [name]: value })); setPreview(null); setPreviewExpired(false); setConfirmed(false); setResult(null); };
    const hasReasonErrors = [
        [form.interestWaiver, form.interestWaiverReason], [form.feeWaiver, form.feeWaiverReason], [form.penaltyWaiver, form.penaltyWaiverReason],
    ].some(([amount, reason]) => hasPositiveAmount(amount) && !reason.trim()) || (hasPositiveAmount(form.externalAmount) && (!form.externalPayer.trim() || !form.externalSource.trim()));

    const replacementTerms = () => {
        const built = buildLoanTermsInput({
            principal: "1.00", interestRate: ["daily", "floating"].includes(form.replacementType) ? "0" : form.interestRate,
            termMonths: form.termMonths || "1", repaymentType: form.replacementType, startDate: form.startDate,
            totalInstallments: form.totalInstallments, installmentAmount: form.installmentAmount,
            dailyDurationUnit: form.dailyDurationUnit, dailyDurationValue: form.dailyDurationValue, dailyEntryMode: form.dailyEntryMode, dailyPayment: form.dailyPayment,
            dailyInterestInputMode: form.dailyInterestInputMode, dailyInterestInputValue: form.dailyInterestInputValue,
            singlePaymentDueDate: form.singleDueDate, singlePaymentFixedAgreedInterest: form.singleFixedInterest, singlePaymentInterestPolicy: form.singlePolicy,
            singlePaymentRetroactiveRateType: form.singleRetroType, singlePaymentRetroactiveRate: form.singleRetroRate, singlePaymentLatePenaltyMode: form.singlePenaltyMode,
            singlePaymentLatePenaltyAmountPerDay: form.singlePenaltyAmount, singlePaymentLatePenaltyGraceDays: form.singlePenaltyGrace,
        } as LoanTermsForm);
        const terms = { ...built };
        delete (terms as Partial<typeof built>).principal;
        return {
            ...terms,
            ...(form.replacementType === "floating" ? { floatingDailyInterest: { mode: form.floatingMode, rate: form.floatingRate, firstDayTreatment: form.firstDayTreatment, accrualCycle: form.floatingAccrualCycle } } : {}),
        };
    };
    const previewRestructure = async () => {
        setBusy(true); setError(""); setResult(null); setConfirmed(false);
        intentKey.current = crypto.randomUUID();
        try {
            const waivers = Object.fromEntries((["interest", "fee", "penalty"] as const).flatMap(component => {
                const amount = form[`${component}Waiver` as keyof typeof form] as string;
                const reason = form[`${component}WaiverReason` as keyof typeof form] as string;
                return hasPositiveAmount(amount) ? [[component === "fee" ? "fees" : component, { amount: emptyToMoney(amount), reason: reason.trim() }]] : [];
            }));
            const response = await api.post(`/loans/${loan.publicId}/restructures/preview`, {
                settlementDate: form.settlementDate, replacementTerms: replacementTerms(), ...(Object.keys(waivers).length ? { waivers } : {}),
                ...(hasPositiveAmount(form.externalAmount) ? { externalSettlementCredit: { amount: emptyToMoney(form.externalAmount), payer: form.externalPayer.trim(), source: form.externalSource.trim() } } : {}),
                additionalPrincipal: emptyToMoney(form.additionalPrincipal), reason: form.reason.trim(),
            });
            const next = response.data as Preview;
            setPreview(next);
            const isExpired = new Date(next.expiresAt).getTime() <= Date.now();
            setPreviewExpired(isExpired);
            if (isExpired) setError(t("restructure.errors.expired"));
            else queueMicrotask(() => previewRef.current?.focus());
        } catch (caught) {
            const code = (caught as { response?: { data?: { code?: string } } }).response?.data?.code;
            setError(code ? t(`domainErrors.${code}`, { defaultValue: t("restructure.errors.preview") }) : t("restructure.errors.preview"));
        } finally { setBusy(false); }
    };
    const execute = async () => {
        if (!preview || expired || !confirmed) return;
        setBusy(true); setError("");
        try {
            const response = await api.post(`/loans/restructures/${preview.publicId}/execute`, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.oldBalanceVersion, reason: form.reason.trim() }, { headers: { "Idempotency-Key": intentKey.current } });
            setResult(response.data); onExecuted?.();
        } catch (caught) {
            const code = (caught as { response?: { data?: { code?: string } } }).response?.data?.code;
            setError(code ? t(`domainErrors.${code}`, { defaultValue: t("restructure.errors.execute") }) : t("restructure.errors.execute"));
            if (code === "STALE_RESTRUCTURE_PREVIEW") { setPreview(null); setConfirmed(false); }
        } finally { setBusy(false); }
    };

    if (loan.status !== "active" || loan.repaymentType !== "single_payment") return null;
    const field = (id: string, label: string, name: keyof typeof form, type = "text") => <label className="grid gap-1 text-sm" htmlFor={id}>{label}<Input id={id} type={type} value={form[name]} onChange={e => update(name, e.target.value)} /></label>;
    return <Card aria-busy={busy}>
        <CardHeader><CardTitle className="flex items-center gap-2"><ArrowRightLeft className="h-5 w-5" />{t("restructure.title")}</CardTitle></CardHeader>
        <CardContent className="space-y-5">
            <p className="text-sm text-muted-foreground">{t("restructure.description")}</p>
            {error && <div ref={errorRef} tabIndex={-1} role="alert" className="flex gap-2 rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div>}
            {!result && <>
                <section className="space-y-3" aria-labelledby="restructure-settlement"><h3 id="restructure-settlement" className="font-semibold">{t("restructure.sections.settlement")}</h3><div className="grid gap-3 sm:grid-cols-2">{field("settlement-date", t("restructure.settlementDate"), "settlementDate", "date")}{field("restructure-reason", t("restructure.reason"), "reason")}{field("interest-waiver", t("restructure.interestWaiver"), "interestWaiver", "number")}{field("interest-waiver-reason", t("restructure.interestWaiverReason"), "interestWaiverReason")}{field("fee-waiver", t("restructure.feeWaiver"), "feeWaiver", "number")}{field("fee-waiver-reason", t("restructure.feeWaiverReason"), "feeWaiverReason")}{field("penalty-waiver", t("restructure.penaltyWaiver"), "penaltyWaiver", "number")}{field("penalty-waiver-reason", t("restructure.penaltyWaiverReason"), "penaltyWaiverReason")}</div></section>
                <section className="space-y-3" aria-labelledby="restructure-external"><h3 id="restructure-external" className="font-semibold">{t("restructure.sections.external")}</h3><p className="text-xs text-muted-foreground">{t("restructure.externalDescription")}</p><div className="grid gap-3 sm:grid-cols-3">{field("external-amount", t("restructure.externalAmount"), "externalAmount", "number")}{field("external-payer", t("restructure.externalPayer"), "externalPayer")}{field("external-source", t("restructure.externalSource"), "externalSource")}</div></section>
                <section className="space-y-3" aria-labelledby="restructure-replacement"><h3 id="restructure-replacement" className="font-semibold">{t("restructure.sections.replacement")}</h3><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm" htmlFor="replacement-type">{t("restructure.replacementType")}<select id="replacement-type" className="flex h-10 rounded-md border bg-background px-3" value={form.replacementType} onChange={e => update("replacementType", e.target.value)}>{["single_payment", "daily", "weekly", "monthly", "floating"].map(type => <option key={type} value={type}>{t(`loanWizard.repaymentOptions.${type}`)}</option>)}</select></label>{field("additional-principal", t("restructure.additionalPrincipal"), "additionalPrincipal", "number")}{field("replacement-start", t("loanWizard.startDate"), "startDate", "date")}{!["daily", "floating"].includes(form.replacementType) && field("replacement-rate", t("loanWizard.interestRate"), "interestRate", "number")}{form.replacementType !== "floating" && field("replacement-term", t("loanWizard.termMonths"), "termMonths", "number")}</div>
                    {form.replacementType === "single_payment" && <div className="mt-3 grid gap-3 sm:grid-cols-2">{field("replacement-due", t("loanWizard.singlePayment.dueDate"), "singleDueDate", "date")}{field("replacement-fixed-interest", t("loanWizard.singlePayment.fixedInterest"), "singleFixedInterest", "number")}<label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={form.singlePolicy === "greater_of_fixed_or_retroactive"} onChange={e => update("singlePolicy", e.target.checked ? "greater_of_fixed_or_retroactive" : "fixed_only")} /><span>{t("loanWizard.singlePayment.compareRetroactive")}</span></label>{form.singlePolicy === "greater_of_fixed_or_retroactive" && <><label className="grid gap-1 text-sm">{t("loanWizard.singlePayment.retroactiveRateType")}<select className="flex h-10 rounded-md border bg-background px-3" value={form.singleRetroType} onChange={e => update("singleRetroType", e.target.value)}><option value="percent_per_day">{t("loanWizard.singlePayment.percentPerDay")}</option><option value="per_thousand_per_day">{t("loanWizard.singlePayment.perThousandPerDay")}</option></select></label>{field("single-retro-rate", t("loanWizard.singlePayment.retroactiveRate"), "singleRetroRate", "number")}</>}<label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={form.singlePenaltyMode === "fixed_amount_per_day"} onChange={e => update("singlePenaltyMode", e.target.checked ? "fixed_amount_per_day" : "none")} /><span>{t("loanWizard.singlePayment.chargePenalty")}</span></label>{form.singlePenaltyMode === "fixed_amount_per_day" && <>{field("single-penalty", t("loanWizard.singlePayment.penaltyPerDay"), "singlePenaltyAmount", "number")}{field("single-grace", t("loanWizard.singlePayment.graceDays"), "singlePenaltyGrace", "number")}</>}</div>}
                    {form.replacementType === "daily" && <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">{t("restructure.dailyDurationUnit")}<select className="flex h-10 rounded-md border bg-background px-3" value={form.dailyDurationUnit} onChange={e => update("dailyDurationUnit", e.target.value)}><option value="days">{t("loanWizard.dailyDurationOptions.days")}</option><option value="months">{t("loanWizard.dailyDurationOptions.months")}</option></select></label>{field("daily-duration", t("loanWizard.dailyDurationValue"), "dailyDurationValue", "number")}<label className="grid gap-1 text-sm">{t("loanWizard.dailyEntryMode")}<select className="flex h-10 rounded-md border bg-background px-3" value={form.dailyEntryMode} onChange={e => update("dailyEntryMode", e.target.value)}><option value="daily_payment">{t("loanWizard.dailyEntryOptions.daily_payment")}</option><option value="daily_interest">{t("loanWizard.dailyEntryOptions.daily_interest")}</option></select></label>{form.dailyEntryMode === "daily_payment" ? field("daily-payment", t("loanWizard.dailyPayment"), "dailyPayment", "number") : <>{field("daily-interest-value", t("loanWizard.dailyInterestValue"), "dailyInterestInputValue", "number")}<label className="grid gap-1 text-sm">{t("loanWizard.dailyInterestInput")}<select className="flex h-10 rounded-md border bg-background px-3" value={form.dailyInterestInputMode} onChange={e => update("dailyInterestInputMode", e.target.value)}>{["percent", "fixed_amount", "per_thousand"].map(mode => <option key={mode} value={mode}>{t(`loanWizard.dailyInterestInputOptions.${mode}`)}</option>)}</select></label></>}</div>}
                    {["weekly", "monthly"].includes(form.replacementType) && <div className="mt-3 grid gap-3 sm:grid-cols-2">{field("replacement-installments", t("loanWizard.totalInstallments"), "totalInstallments", "number")}{field("replacement-installment-amount", t("restructure.exactInstallmentAmount"), "installmentAmount", "number")}</div>}
                    {form.replacementType === "floating" && <div className="mt-3 grid gap-3 sm:grid-cols-2">{field("floating-rate", t("loanWizard.dailyInterestValue"), "floatingRate", "number")}<label className="grid gap-1 text-sm">{t("loanWizard.dailyInterestMode")}<select className="flex h-10 rounded-md border bg-background px-3" value={form.floatingMode} onChange={e => update("floatingMode", e.target.value)}><option value="percent">{t("loanWizard.dailyInterestPercent")}</option><option value="per_thousand">{t("loanWizard.dailyInterestPerThousand")}</option></select></label><label className="grid gap-1 text-sm">{t("loanWizard.floatingAccrualCycle")}<select className="flex h-10 rounded-md border bg-background px-3" value={form.floatingAccrualCycle} onChange={e => update("floatingAccrualCycle", e.target.value)}><option value="daily">{t("loanWizard.floatingAccrualOptions.daily")}</option><option value="weekly">{t("loanWizard.floatingAccrualOptions.weekly")}</option></select></label><label className="grid gap-1 text-sm">{t("loanWizard.firstDayTreatment")}<select className="flex h-10 rounded-md border bg-background px-3" value={form.firstDayTreatment} onChange={e => update("firstDayTreatment", e.target.value)}><option value="start_next_day">{t("loanWizard.startNextDay")}</option><option value="deduct">{t("loanWizard.deductFirstDay")}</option></select></label></div>}
                </section>
                {!preview && <Button disabled={busy || !form.reason.trim() || hasReasonErrors} onClick={() => void previewRestructure()}>{t("restructure.preview")}</Button>}
            </>}
            {preview && !expired && !result && <section ref={previewRef} tabIndex={-1} className="space-y-4 rounded border p-4" aria-labelledby="restructure-review"><h3 id="restructure-review" className="font-semibold">{t("restructure.reviewTitle")}</h3><div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">{(["fixedInterestCandidate", "retroactiveInterestCandidate", "selectedInterest", "grossPrincipal", "grossInterest", "grossFees", "grossPenalty", "waivedInterest", "waivedFees", "waivedPenalty", "netPrincipal", "netInterest", "netFees", "netPenalty"] as const).filter(key => typeof preview.balance[key] === "string").map(key => <div key={key}><span className="text-muted-foreground">{t(`restructure.components.${key}`)}</span><div className="font-medium tabular-nums">{money(preview.balance[key] as string)}</div></div>)}<div><span className="text-muted-foreground">{t("restructure.replacementPrincipal")}</span><div className="font-medium">{money(preview.replacementPrincipal)}</div></div><div><span className="text-muted-foreground">{t("restructure.cashMovement")}</span><div className="font-medium">{t(`restructure.cashDirection.${preview.cash.direction}`)} · {money(preview.cash.amount)}</div></div></div><p className="text-xs text-muted-foreground">{t("restructure.interestAlternative")}</p>{Array.isArray(preview.balance.exposureTrace) && preview.balance.exposureTrace.length > 0 && <div><h4 className="text-sm font-semibold">{t("restructure.exposureTrace")}</h4><div className="mt-2 space-y-2">{preview.balance.exposureTrace.map((segment, index) => <div key={`${segment.fromDate}-${segment.toDate}-${index}`} className="rounded bg-muted/40 p-3 text-sm"><div>{date(segment.fromDate)} → {date(segment.toDate)} · {money(segment.amount)}</div><div className="text-xs text-muted-foreground">{t("restructure.exposureTraceDetail", { rateType: rateType(segment.rateType), rate: segment.rate ?? "0", days: segment.days, amount: money(segment.roundedInterest) })}</div></div>)}</div></div>}<div className="rounded border p-3 text-sm"><h4 className="font-semibold">{t("restructure.externalConfirmation")}</h4><p className="mt-1">{hasPositiveAmount(form.externalAmount) ? t("restructure.externalIdentity", { amount: money(emptyToMoney(form.externalAmount)), payer: form.externalPayer, source: form.externalSource }) : t("restructure.noExternalPayment")}</p><dl className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{(["penalty", "fee", "interest", "principal", "unallocated"] as const).map(component => <div key={component}><dt className="text-muted-foreground">{t(`restructure.externalAllocation.${component}`)}</dt><dd className="font-medium">{money(preview.externalCreditAllocation[component])}</dd></div>)}</dl><p className="mt-2 text-xs text-muted-foreground">{t("restructure.externalReconciliation", { amount: money(emptyToMoney(form.externalAmount)), unallocated: money(preview.externalCreditAllocation.unallocated) })}</p></div><p className="text-xs text-muted-foreground">{t("restructure.disbursementDisclosure")}</p>{preview.schedule.length > 0 && <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>#</th><th>{t("loanWizard.columns.dueDate")}</th><th>{t("loanWizard.columns.principal")}</th><th>{t("loanWizard.columns.interest")}</th><th>{t("loanWizard.columns.amount")}</th></tr></thead><tbody>{preview.schedule.map(row => <tr key={row.installmentNo} className="border-t"><td>{row.installmentNo}</td><td>{date(row.dueDate)}</td><td>{money(row.principalComponent)}</td><td>{money(row.interestComponent)}</td><td>{money(row.amount)}</td></tr>)}</tbody></table></div>}<div className="text-xs text-muted-foreground">{t("restructure.expiresAt", { value: new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(preview.expiresAt)) })}</div><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /><span>{t("restructure.confirmExact")}</span></label><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setPreview(null)}>{t("restructure.edit")}</Button><Button disabled={busy || !confirmed} onClick={() => void execute()}><CheckCircle2 className="mr-2 h-4 w-4" />{t("restructure.execute")}</Button></div></section>}
            {result && <div role="status" className="rounded border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm"><div className="font-medium text-emerald-700">{t("restructure.executed", { id: result.newLoanPublicId })}</div>{result.disbursementDraftPublicId && <p className="mt-2">{t("restructure.disbursementDraft", { id: result.disbursementDraftPublicId })}</p>}</div>}
        </CardContent>
    </Card>;
}
