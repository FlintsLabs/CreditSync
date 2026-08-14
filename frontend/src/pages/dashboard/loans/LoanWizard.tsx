import { useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api";
import { getStoredUser, isTenantAdminUser } from "../../../lib/session";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { ChevronRight, ChevronLeft, CheckCircle, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { buildLoanTermsInput, formatMoneyExact } from "../../../lib/workflow-model";
import { FloatingInterestSummary, type FloatingInterestPolicyView } from "./FloatingInterestSummary";

interface Borrower {
    id: string;
    publicId: string;
    name: string;
    idCardNumber?: string | null;
}

interface DrawdownOption {
    id: number;
    publicId: string;
    bankProfileId: number | null;
    amount: string;
    outstandingPrincipal: string | null;
    nextDueDate: string | null;
    status: string | null;
    note?: string | null;
}

interface BankProfile {
    id: number;
    publicId: string;
    name: string;
    creditLimit: string | null;
    accountingMode?: string | null;
    status?: string | null;
}

interface LoanSchedulePreview {
    installmentNo: number;
    dueDate: string;
    amount: string;
    principalComponent: string;
    interestComponent: string;
    remainingPrincipal: string;
}

interface DailyLoanCalculation {
    totalInstallments: number;
    installmentAmount: string;
    totalRepayment: string;
    totalInterest: string;
    dailyInterest: string;
    flatDailyRatePercent: string;
    flatMonthlyRatePercent: string;
    flatAnnualRatePercent: string;
}

interface FloatingLoanPreview {
    floatingInterestPolicy: FloatingInterestPolicyView;
    fullPeriodInterest: string;
    advanceInterest: string;
    netBorrowerPayout: string;
    firstPeriodStartDate: string;
    firstPeriodDueDate: string;
    periodDays: number;
}

export default function LoanWizard() {
    const { t, i18n } = useTranslation();
    const currentUser = getStoredUser();
    const isTenantAdmin = isTenantAdminUser(currentUser);
    const [step, setStep] = useState(1);
    const [borrowers, setBorrowers] = useState<Borrower[]>([]);
    const [drawdowns, setDrawdowns] = useState<DrawdownOption[]>([]);
    const [bankProfiles, setBankProfiles] = useState<BankProfile[]>([]);
    const [loadingDependencies, setLoadingDependencies] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const [draftId, setDraftId] = useState("");
    const [dailyCalculation, setDailyCalculation] = useState<DailyLoanCalculation | null>(null);
    const [floatingPreview, setFloatingPreview] = useState<FloatingLoanPreview | null>(null);
    const activationIntentRef = useRef<{ draftId: string; key: string } | null>(null);

    const [formData, setFormData] = useState({
        borrowerId: "",
        bankLoanId: "",
        bankProfileId: "",
        principal: "",
        interestRate: "15",
        termMonths: "12",
        repaymentType: "monthly",
        floatingPeriodUnit: "day" as "day" | "week",
        floatingRateMode: "per_thousand" as "per_thousand" | "percent",
        floatingRate: "15",
        advanceInterestPeriods: 0 as 0 | 1,
        startDate: new Date().toISOString().split("T")[0],
        totalInstallments: "",
        installmentAmount: "",
        dailyDurationUnit: "days" as "days" | "months",
        dailyDurationValue: "15",
        dailyEntryMode: "daily_payment" as "daily_payment" | "daily_interest",
        dailyPayment: "",
        dailyInterestInputMode: "percent" as "percent" | "fixed_amount" | "per_thousand",
        dailyInterestInputValue: "",
        floatingAccrualCycle: "daily" as "daily" | "weekly",
        singlePaymentDueDate: "",
        singlePaymentFixedAgreedInterest: "",
        singlePaymentInterestPolicy: "fixed_only" as "fixed_only" | "greater_of_fixed_or_retroactive",
        singlePaymentRetroactiveRateType: "percent_per_day" as "percent_per_day" | "per_thousand_per_day",
        singlePaymentRetroactiveRate: "",
        singlePaymentLatePenaltyMode: "none" as "none" | "fixed_amount_per_day",
        singlePaymentLatePenaltyAmountPerDay: "",
        singlePaymentLatePenaltyGraceDays: "0",
    });

    const [schedule, setSchedule] = useState<LoanSchedulePreview[]>([]);
    const date = (value: string) => new Intl.DateTimeFormat(i18n.language).format(new Date(`${value}T00:00:00`));
    const money = (value: string) => formatMoneyExact(value, i18n.language);
    const localizedError = (caught: unknown, fallbackKey: string) => {
        const code = (caught as { response?: { data?: { code?: string } } }).response?.data?.code;
        return code ? t(`domainErrors.${code}`, { defaultValue: t(fallbackKey) }) : t(fallbackKey);
    };

    useEffect(() => {
        const loadDependencies = async () => {
            try {
                const [borrowersRes, drawdownsRes, profilesRes] = await Promise.all([
                    api.get("/borrowers"),
                    isTenantAdmin ? api.get("/bank-loans") : Promise.resolve({ data: [] }),
                    isTenantAdmin ? api.get("/bank-profiles") : Promise.resolve({ data: [] }),
                ]);
                setBorrowers(borrowersRes.data ?? []);
                setDrawdowns((drawdownsRes.data ?? []).filter((item: DrawdownOption) => item.status !== "closed"));
                setBankProfiles(profilesRes.data ?? []);
            } catch (error) {
                console.error("Failed to load loan wizard dependencies", error);
                setErrorMessage(t("loanWizard.errors.loadDependencies", "Unable to load borrowers and funds right now."));
            } finally {
                setLoadingDependencies(false);
            }
        };

        loadDependencies();
    }, [isTenantAdmin, t]);

    const selectedDrawdown = drawdowns.find((item) => item.publicId === formData.bankLoanId);
    const selectedDrawdownProfile = bankProfiles.find((item) => item.id === selectedDrawdown?.bankProfileId);
    const ownCapitalProfiles = bankProfiles.filter((item) => item.accountingMode === "capital_pool" && item.status !== "inactive");
    const selectedOwnCapital = ownCapitalProfiles.find((item) => item.publicId === formData.bankProfileId);
    const bankProfileNameById = new Map(bankProfiles.map((item) => [item.id, item.name]));
    const floatingInterestPolicy: FloatingInterestPolicyView = {
        periodUnit: formData.floatingPeriodUnit,
        periodLength: 1,
        rateMode: formData.floatingRateMode,
        rate: formData.floatingRate,
        advanceInterestPeriods: formData.advanceInterestPeriods,
        advanceInterestRefundPolicy: "non_refundable",
    };

    const calculateSchedule = async () => {
        try {
            const res = await api.post("/loans/preview", {
                ...buildLoanTermsInput({ ...formData, interestRate: ["floating", "daily"].includes(formData.repaymentType) ? "0" : formData.interestRate }),
                ...(formData.repaymentType === "floating" ? { floatingInterestPolicy } : {}),
            });
            setSchedule(res.data?.schedule ?? []);
            setDailyCalculation(res.data?.dailyLoanCalculation ?? null);
            setFloatingPreview(formData.repaymentType === "floating" ? res.data as FloatingLoanPreview : null);
            return true;
        } catch (error) {
            console.error("Calculation failed", error);
            setErrorMessage(t("loanWizard.errors.calculate", "Unable to calculate the borrower schedule."));
            return false;
        }
    };

    const handleNext = async () => {
        setErrorMessage("");
        if (step === 2) {
            const success = await calculateSchedule();
            if (success) setStep(3);
            return;
        }
        setStep(step + 1);
    };

    const handleSubmit = async () => {
        try {
            setSubmitting(true);
            setErrorMessage("");

            const draft = await api.post("/loans", {
                borrowerPublicId: formData.borrowerId,
                bankLoanPublicId: isTenantAdmin && formData.bankLoanId ? formData.bankLoanId : undefined,
                bankProfilePublicId: isTenantAdmin && formData.bankProfileId ? formData.bankProfileId : undefined,
                floatingInterestPolicy: formData.repaymentType === "floating" ? floatingInterestPolicy : undefined,
                ...buildLoanTermsInput({ ...formData, interestRate: ["floating", "daily"].includes(formData.repaymentType) ? "0" : formData.interestRate }),
            });
            setDraftId(draft.data.publicId);
            activationIntentRef.current = null;
            setStep(4);
        } catch (error: unknown) {
            console.error("Failed to create loan", error);
            setErrorMessage(localizedError(error, "loanWizard.errors.create"));
        } finally {
            setSubmitting(false);
        }
    };

    const handleActivate = async () => {
        try {
            setSubmitting(true);
            setErrorMessage("");
            if (activationIntentRef.current?.draftId !== draftId) {
                activationIntentRef.current = { draftId, key: crypto.randomUUID() };
            }
            await api.post(`/loans/${draftId}/activate`, undefined, {
                headers: { "Idempotency-Key": activationIntentRef.current.key },
            });
            window.location.href = `/loans/${draftId}`;
        } catch (error: unknown) {
            setErrorMessage(localizedError(error, "loanWizard.errors.activate"));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <h2 className="text-3xl font-bold">{t("loanWizard.title", "New Loan Agreement")}</h2>

            <div className="flex gap-2">
                {[1, 2, 3, 4].map((i) => (
                    <div key={i} className={`h-2 flex-1 rounded-full ${step >= i ? "bg-primary" : "bg-muted"}`} />
                ))}
            </div>

            {errorMessage && (
                <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 mt-0.5" />
                    <span>{errorMessage}</span>
                </div>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>
                        {step === 1 && t("loanWizard.steps.select", "Step 1: Select Borrower & Funding")}
                        {step === 2 && t("loanWizard.steps.terms", "Step 2: Loan Terms")}
                        {step === 3 && t("loanWizard.steps.review", "Step 3: Review & Confirm")}
                        {step === 4 && t("loanWizard.steps.activate")}
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    {step === 1 && (
                        <>
                            <div className="grid gap-2">
                                <label>{t("loanWizard.borrower", "Borrower")}</label>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={formData.borrowerId}
                                    onChange={(e) => setFormData({ ...formData, borrowerId: e.target.value })}
                                    disabled={loadingDependencies}
                                >
                                    <option value="">{t("loanWizard.selectBorrower", "Select Borrower...")}</option>
                                    {borrowers.map((b) => (
                                        <option key={b.publicId} value={b.publicId}>
                                            {b.name} {b.idCardNumber ? `(${b.idCardNumber})` : ""}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="grid gap-2">
                                <label>{t("loanWizard.fundingSource", "Funding Source (Optional)")}</label>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={formData.bankLoanId ? `drawdown:${formData.bankLoanId}` : formData.bankProfileId ? `capital:${formData.bankProfileId}` : ""}
                                    onChange={(e) => {
                                        const [kind, publicId] = e.target.value.split(":");
                                        setFormData({
                                            ...formData,
                                            bankLoanId: kind === "drawdown" ? publicId ?? "" : "",
                                            bankProfileId: kind === "capital" ? publicId ?? "" : "",
                                        });
                                    }}
                                    disabled={loadingDependencies}
                                >
                                    <option value="">{t("loanWizard.noneDrawdown", "None (allocate later)")}</option>
                                    <optgroup label={t("loanWizard.ownCapital", "Own capital")}>
                                        {ownCapitalProfiles.map((item) => (
                                            <option key={item.publicId} value={`capital:${item.publicId}`}>
                                                {item.name} — {money(item.creditLimit ?? "0.00")}
                                            </option>
                                        ))}
                                    </optgroup>
                                    <optgroup label={t("loanWizard.drawdowns", "Bank drawdowns")}>
                                        {drawdowns.map((item) => (
                                            <option key={item.publicId} value={`drawdown:${item.publicId}`}>
                                                #{item.id} {item.bankProfileId ? bankProfileNameById.get(item.bankProfileId) ?? "" : ""} {money(item.outstandingPrincipal ?? item.amount)}
                                            </option>
                                        ))}
                                    </optgroup>
                                </select>
                            </div>

                            {selectedDrawdown && (
                                <div className="rounded-lg border bg-muted/30 p-4 text-sm">
                                    <div className="font-medium">{t("loanWizard.selectedDrawdown", "Selected drawdown")}</div>
                                    <div className="mt-1 text-muted-foreground">
                                        {t("loanWizard.source", "Source")}: {selectedDrawdownProfile?.name ?? t("loanWizard.unknownSource", "Unknown source")}
                                    </div>
                                    <div className="text-muted-foreground">
                                        {t("loanWizard.outstandingPrincipal", "Outstanding principal")}: {money(selectedDrawdown.outstandingPrincipal ?? "0.00")}
                                    </div>
                                    <div className="text-muted-foreground">
                                        {t("loanWizard.nextDue", "Next due")}: {selectedDrawdown.nextDueDate ? date(selectedDrawdown.nextDueDate) : t("loanWizard.notScheduled", "Not scheduled")}
                                    </div>
                                </div>
                            )}
                            {selectedOwnCapital && (
                                <div className="rounded-lg border bg-muted/30 p-4 text-sm">
                                    <div className="font-medium">{t("loanWizard.selectedOwnCapital", "Selected own capital")}</div>
                                    <div className="mt-1 text-muted-foreground">{selectedOwnCapital.name}</div>
                                    <div className="text-muted-foreground">
                                        {t("loanWizard.availableCapital", "Capital pool limit")}: {money(selectedOwnCapital.creditLimit ?? "0.00")}
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    {step === 2 && (
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="grid gap-2 md:col-span-2">
                                <label>{t("loanWizard.repaymentType", "Repayment Type")}</label>
                                <div className="flex flex-wrap gap-2" role="radiogroup">
                                    {(["single_payment", "monthly", "daily", "weekly", "floating"] as const).map((type) => (
                                        <button key={type} type="button" role="radio" aria-checked={formData.repaymentType === type} onClick={() => setFormData({ ...formData, repaymentType: type })} className={`rounded-full border px-3 py-2 text-sm transition-colors ${formData.repaymentType === type ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted"}`}>
                                            {t(`loanWizard.repaymentOptions.${type}`)}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="grid gap-2">
                                <label htmlFor="loan-principal">{t("loanWizard.principalAmount", "Principal Amount (฿)")}</label>
                                <Input id="loan-principal" type="number" value={formData.principal} onChange={(e) => setFormData({ ...formData, principal: e.target.value })} />
                            </div>
                            {!["floating", "daily"].includes(formData.repaymentType) && (
                                <div className="grid gap-2">
                                    <label>{t("loanWizard.interestRate", "Interest Rate (% per year)")}</label>
                                    <Input type="number" value={formData.interestRate} onChange={(e) => setFormData({ ...formData, interestRate: e.target.value })} />
                                </div>
                            )}
                            {!["floating", "daily"].includes(formData.repaymentType) && (
                                <div className="grid gap-2">
                                    <label>{t("loanWizard.termMonths", "Term (Months)")}</label>
                                    <Input type="number" value={formData.termMonths} onChange={(e) => setFormData({ ...formData, termMonths: e.target.value })} />
                                </div>
                            )}
                            <div className="grid gap-2">
                                <label>{t("loanWizard.startDate", "Start Date")}</label>
                                <Input
                                    type="date"
                                    value={formData.startDate}
                                    onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                                    onClick={(event) => event.currentTarget.showPicker?.()}
                                />
                            </div>
                            {formData.repaymentType === "single_payment" && (
                                <fieldset className="grid gap-4 rounded border p-4 md:col-span-2">
                                    <legend className="px-1 font-medium">{t("loanWizard.singlePayment.title")}</legend>
                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <label className="grid gap-2" htmlFor="single-payment-due">{t("loanWizard.singlePayment.dueDate")}<Input id="single-payment-due" type="date" value={formData.singlePaymentDueDate} onChange={e => setFormData({ ...formData, singlePaymentDueDate: e.target.value })} /></label>
                                        <label className="grid gap-2" htmlFor="single-payment-interest">{t("loanWizard.singlePayment.fixedInterest")}<Input id="single-payment-interest" type="number" min="0" step="0.01" value={formData.singlePaymentFixedAgreedInterest} onChange={e => setFormData({ ...formData, singlePaymentFixedAgreedInterest: e.target.value })} /></label>
                                    </div>
                                    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={formData.singlePaymentInterestPolicy === "greater_of_fixed_or_retroactive"} onChange={e => setFormData({ ...formData, singlePaymentInterestPolicy: e.target.checked ? "greater_of_fixed_or_retroactive" : "fixed_only" })} /><span>{t("loanWizard.singlePayment.compareRetroactive")}</span></label>
                                    {formData.singlePaymentInterestPolicy === "greater_of_fixed_or_retroactive" && <div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-2">{t("loanWizard.singlePayment.retroactiveRateType")}<select className="flex h-10 rounded-md border bg-background px-3" value={formData.singlePaymentRetroactiveRateType} onChange={e => setFormData({ ...formData, singlePaymentRetroactiveRateType: e.target.value as typeof formData.singlePaymentRetroactiveRateType })}><option value="percent_per_day">{t("loanWizard.singlePayment.percentPerDay")}</option><option value="per_thousand_per_day">{t("loanWizard.singlePayment.perThousandPerDay")}</option></select></label><label className="grid gap-2" htmlFor="single-payment-retro-rate">{t("loanWizard.singlePayment.retroactiveRate")}<Input id="single-payment-retro-rate" type="number" min="0" step="0.0001" value={formData.singlePaymentRetroactiveRate} onChange={e => setFormData({ ...formData, singlePaymentRetroactiveRate: e.target.value })} /></label></div>}
                                    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={formData.singlePaymentLatePenaltyMode === "fixed_amount_per_day"} onChange={e => setFormData({ ...formData, singlePaymentLatePenaltyMode: e.target.checked ? "fixed_amount_per_day" : "none" })} /><span>{t("loanWizard.singlePayment.chargePenalty")}</span></label>
                                    {formData.singlePaymentLatePenaltyMode === "fixed_amount_per_day" && <div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-2" htmlFor="single-payment-penalty">{t("loanWizard.singlePayment.penaltyPerDay")}<Input id="single-payment-penalty" type="number" min="0" step="0.01" value={formData.singlePaymentLatePenaltyAmountPerDay} onChange={e => setFormData({ ...formData, singlePaymentLatePenaltyAmountPerDay: e.target.value })} /></label><label className="grid gap-2" htmlFor="single-payment-grace">{t("loanWizard.singlePayment.graceDays")}<Input id="single-payment-grace" type="number" min="0" step="1" value={formData.singlePaymentLatePenaltyGraceDays} onChange={e => setFormData({ ...formData, singlePaymentLatePenaltyGraceDays: e.target.value })} /></label></div>}
                                    <p className="text-xs text-muted-foreground">{t("loanWizard.singlePayment.backendValidation")}</p>
                                </fieldset>
                            )}
                            {formData.repaymentType === "daily" && (
                                <>
                                    <div className="grid gap-2">
                                        <label>{t("loanWizard.dailyDuration")}</label>
                                        <div className="flex gap-2">{(["days", "months"] as const).map((unit) => <button key={unit} type="button" onClick={() => setFormData({ ...formData, dailyDurationUnit: unit })} className={`rounded-full border px-3 py-2 text-sm ${formData.dailyDurationUnit === unit ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>{t(`loanWizard.dailyDurationOptions.${unit}`)}</button>)}</div>
                                    </div>
                                    <div className="grid gap-2">
                                        <label>{t("loanWizard.dailyDurationValue")}</label>
                                        <Input type="number" min="1" value={formData.dailyDurationValue} onChange={(e) => setFormData({ ...formData, dailyDurationValue: e.target.value })} />
                                    </div>
                                    <div className="grid gap-2 md:col-span-2">
                                        <label>{t("loanWizard.dailyEntryMode")}</label>
                                        <div className="flex flex-wrap gap-2">{(["daily_payment", "daily_interest"] as const).map((mode) => <button key={mode} type="button" onClick={() => setFormData({ ...formData, dailyEntryMode: mode })} className={`rounded-full border px-3 py-2 text-sm ${formData.dailyEntryMode === mode ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>{t(`loanWizard.dailyEntryOptions.${mode}`)}</button>)}</div>
                                    </div>
                                    {formData.dailyEntryMode === "daily_payment" ? <div className="grid gap-2"><label>{t("loanWizard.dailyPayment")}</label><Input type="number" min="0.01" step="0.01" value={formData.dailyPayment} onChange={(e) => setFormData({ ...formData, dailyPayment: e.target.value })} /></div> : <><div className="grid gap-2"><label>{t("loanWizard.dailyInterestInput")}</label><div className="flex flex-wrap gap-2">{(["percent", "fixed_amount", "per_thousand"] as const).map((mode) => <button key={mode} type="button" onClick={() => setFormData({ ...formData, dailyInterestInputMode: mode })} className={`rounded-full border px-3 py-2 text-sm ${formData.dailyInterestInputMode === mode ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>{t(`loanWizard.dailyInterestInputOptions.${mode}`)}</button>)}</div></div><div className="grid gap-2"><label>{t("loanWizard.dailyInterestValue")}</label><Input type="number" min="0" step="0.0001" value={formData.dailyInterestInputValue} onChange={(e) => setFormData({ ...formData, dailyInterestInputValue: e.target.value })} /></div></>}
                                </>
                            )}
                            {formData.repaymentType === "floating" && (
                                <>
                                    <div className="grid gap-2 md:col-span-2">
                                        <label>{t("loanWizard.floating.periodUnit")}</label>
                                        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("loanWizard.floating.periodUnit")}>
                                            {(["day", "week"] as const).map((unit) => <button key={unit} type="button" role="radio" aria-checked={formData.floatingPeriodUnit === unit} onClick={() => setFormData({ ...formData, floatingPeriodUnit: unit })} className={`rounded-full border px-3 py-2 text-sm ${formData.floatingPeriodUnit === unit ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>{t(`loanWizard.floating.periodOptions.${unit}`)}</button>)}
                                        </div>
                                    </div>
                                    <div className="grid gap-2 md:col-span-2">
                                        <label>{t("loanWizard.floating.rateMode")}</label>
                                        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("loanWizard.floating.rateMode")}>
                                            {(["per_thousand", "percent"] as const).map((mode) => <button key={mode} type="button" role="radio" aria-checked={formData.floatingRateMode === mode} onClick={() => setFormData({ ...formData, floatingRateMode: mode })} className={`rounded-full border px-3 py-2 text-sm ${formData.floatingRateMode === mode ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>{t(`loanWizard.floating.rateOptions.${mode}`)}</button>)}
                                        </div>
                                    </div>
                                    <div className="grid gap-2">
                                        <label htmlFor="floating-contract-rate">{t("loanWizard.floating.contractRate")}</label>
                                        <Input id="floating-contract-rate" type="number" min="0.0001" step="0.0001" value={formData.floatingRate} onChange={(e) => setFormData({ ...formData, floatingRate: e.target.value })} />
                                    </div>
                                    <div className="grid gap-2 md:col-span-2">
                                        <label>{t("loanWizard.floating.advanceInterest")}</label>
                                        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("loanWizard.floating.advanceInterest")}>
                                            {([0, 1] as const).map((periods) => <button key={periods} type="button" role="radio" aria-checked={formData.advanceInterestPeriods === periods} onClick={() => setFormData({ ...formData, advanceInterestPeriods: periods })} className={`rounded-full border px-3 py-2 text-sm ${formData.advanceInterestPeriods === periods ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>{t(`loanWizard.floating.advanceOptions.${periods}`)}</button>)}
                                        </div>
                                        {formData.advanceInterestPeriods === 1 && <p className="text-xs text-amber-700 dark:text-amber-300">{t("loanWizard.floating.nonRefundableWarning")}</p>}
                                    </div>
                                    <div className="grid gap-2 md:col-span-2"><label>{t("loanWizard.floatingAccrualCycle")}</label><div className="flex gap-2">{(["daily", "weekly"] as const).map(cycle => <button key={cycle} type="button" onClick={() => setFormData({ ...formData, floatingAccrualCycle: cycle })} className={`rounded-full border px-3 py-2 text-sm ${formData.floatingAccrualCycle === cycle ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>{t(`loanWizard.floatingAccrualOptions.${cycle}`)}</button>)}</div></div>
                                </>
                            )}
                        </div>
                    )}

                    {step === 3 && (
                        <div className="space-y-4">
                            {formData.repaymentType === "single_payment" && <div role="note" className="rounded border border-blue-500/30 bg-blue-500/10 p-4 text-sm"><div className="font-medium">{t("loanWizard.singlePayment.reviewTitle")}</div><p className="mt-1 text-muted-foreground">{t("loanWizard.singlePayment.alternativeNotice")}</p></div>}
                            {formData.repaymentType === "floating" && floatingPreview && (
                                <FloatingInterestSummary
                                    policy={floatingPreview.floatingInterestPolicy}
                                    fullPeriodInterest={floatingPreview.fullPeriodInterest}
                                    advanceInterest={floatingPreview.advanceInterest}
                                    netBorrowerPayout={floatingPreview.netBorrowerPayout}
                                    firstPeriodStartDate={floatingPreview.firstPeriodStartDate}
                                    firstPeriodDueDate={floatingPreview.firstPeriodDueDate}
                                    periodDays={floatingPreview.periodDays}
                                />
                            )}
                            {dailyCalculation && <div className="rounded-md border bg-muted/30 p-4 text-sm"><div className="font-medium">{t("loanWizard.dailyCalculation")}</div><div className="mt-2 grid gap-1 sm:grid-cols-2"><div>{t("loanWizard.totalInstallments")}: {dailyCalculation.totalInstallments}</div><div>{t("loanWizard.dailyPayment")}: {money(dailyCalculation.installmentAmount)}</div><div>{t("loanWizard.totalRepayment")}: {money(dailyCalculation.totalRepayment)}</div><div>{t("loanWizard.totalInterest")}: {money(dailyCalculation.totalInterest)}</div><div>{t("loanWizard.dailyInterest")}: {money(dailyCalculation.dailyInterest)}</div><div>{t("loanWizard.flatDailyRate")}: {dailyCalculation.flatDailyRatePercent}%</div><div>{t("loanWizard.flatMonthlyRate")}: {dailyCalculation.flatMonthlyRatePercent}%</div><div>{t("loanWizard.flatAnnualRate")}: {dailyCalculation.flatAnnualRatePercent}%</div></div></div>}
                            <div className="rounded-md border p-4 text-sm">
                                <div className="font-medium">{t("loanWizard.fundingSetup", "Funding setup")}</div>
                                <div className="mt-1 text-muted-foreground">
                                    {formData.bankLoanId
                                        ? t("loanWizard.review.withDrawdown", { defaultValue: "This loan will be created against drawdown #{{id}}.", id: formData.bankLoanId })
                                        : formData.bankProfileId
                                            ? t("loanWizard.review.withOwnCapital", { defaultValue: "This loan will use own capital from {{name}}.", name: selectedOwnCapital?.name ?? formData.bankProfileId })
                                        : t("loanWizard.review.withoutDrawdown", "This loan will be created without a matched drawdown and can be allocated later.")}
                                </div>
                            </div>
                            <div className="bg-muted p-4 rounded-md">
                                <h3 className="font-semibold mb-2">{t("loanWizard.schedulePreview", "Installment Schedule Preview")}</h3>
                                {schedule.length === 0 ? (
                                    <div className="text-sm text-muted-foreground">
                                        {t("loanWizard.noFixedSchedule", "Floating repayment type has no fixed borrower schedule.")}
                                    </div>
                                ) : (
                                    <div className="max-h-60 overflow-y-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="text-left">
                                                    <th className="p-2">#</th>
                                                    <th className="p-2">{t("loanWizard.columns.dueDate", "Due Date")}</th>
                                                    <th className="p-2">{t("loanWizard.columns.amount", "Amount")}</th>
                                                    <th className="p-2">{t("loanWizard.columns.principal", "Principal")}</th>
                                                    <th className="p-2">{t("loanWizard.columns.interest", "Interest")}</th>
                                                    <th className="p-2">{t("loanWizard.columns.balance", "Balance")}</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {schedule.map((row) => (
                                                    <tr key={row.installmentNo} className="border-t">
                                                        <td className="p-2">{row.installmentNo}</td>
                                                        <td className="p-2">{date(row.dueDate)}</td>
                                                        <td className="p-2">{money(row.amount)}</td>
                                                        <td className="p-2 text-muted-foreground">{money(row.principalComponent)}</td>
                                                        <td className="p-2 text-destructive">{money(row.interestComponent)}</td>
                                                        <td className="p-2">{money(row.remainingPrincipal)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {step === 4 && (
                        <div className="space-y-4">
                            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-5">
                                <div className="flex items-center gap-2 font-semibold text-emerald-700"><CheckCircle className="h-5 w-5" />{t("loanWizard.draft.saved")}</div>
                                <p className="mt-2 text-sm text-muted-foreground">{t("loanWizard.draft.description")}</p>
                                <div className="mt-3 break-all font-mono text-xs">{t("loanWizard.draft.id")}: {draftId}</div>
                            </div>
                            <div className="rounded border p-4 text-sm text-muted-foreground">{t("loanWizard.draft.activationNotice")}</div>
                        </div>
                    )}

                    <div className="flex justify-between pt-4">
                        <Button variant="outline" onClick={() => setStep(step - 1)} disabled={step === 1 || step === 4 || submitting}>
                            <ChevronLeft className="mr-2 h-4 w-4" /> {t("common.back", "Back")}
                        </Button>

                        {step < 3 ? (
                            <Button
                                onClick={handleNext}
                                disabled={loadingDependencies || !formData.borrowerId || (step === 2 && !formData.principal)}
                            >
                                {t("common.next", "Next")} <ChevronRight className="ml-2 h-4 w-4" />
                            </Button>
                        ) : step === 3 ? (
                            <Button onClick={handleSubmit} className="bg-green-600 hover:bg-green-700" disabled={submitting}>
                                <CheckCircle className="mr-2 h-4 w-4" /> {submitting ? t("loanWizard.creating", "Creating...") : t("loanWizard.draft.save")}
                            </Button>
                        ) : (
                            <Button onClick={handleActivate} className="bg-green-600 hover:bg-green-700" disabled={submitting || !draftId}>
                                <CheckCircle className="mr-2 h-4 w-4" /> {submitting ? t("loanWizard.draft.activating") : t("loanWizard.draft.activate")}
                            </Button>
                        )}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
