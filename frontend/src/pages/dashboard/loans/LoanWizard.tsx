import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { getStoredUser, isTenantAdminUser } from "../../../lib/session";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { ChevronRight, ChevronLeft, CheckCircle, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

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
    name: string;
}

interface LoanSchedulePreview {
    installmentNo: number;
    dueDate: string;
    amount: string;
    principalComponent: string;
    interestComponent: string;
    remainingPrincipal: string;
}

function toPublicMoney(value: string) {
    const normalized = value.trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
        throw new Error("Money must be a non-negative amount with at most two decimal places");
    }
    const [whole, fractional = ""] = normalized.split(".");
    return `${whole}.${fractional.padEnd(2, "0")}`;
}

function toPositiveInteger(value: string, label: string) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive whole number`);
    }
    return parsed;
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

    const [formData, setFormData] = useState({
        borrowerId: "",
        bankLoanId: "",
        principal: "",
        interestRate: "15",
        termMonths: "12",
        repaymentType: "monthly",
        startDate: new Date().toISOString().split("T")[0]
    });

    const [schedule, setSchedule] = useState<LoanSchedulePreview[]>([]);

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
    const bankProfileNameById = new Map(bankProfiles.map((item) => [item.id, item.name]));

    const calculateSchedule = async () => {
        try {
            const res = await api.post("/loans/preview", {
                principal: toPublicMoney(formData.principal),
                interestRate: toPublicMoney(formData.interestRate),
                termMonths: toPositiveInteger(formData.termMonths, "Term months"),
                repaymentType: formData.repaymentType,
                startDate: formData.startDate
            });
            setSchedule(res.data?.schedule ?? []);
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

            const total = schedule.length || toPositiveInteger(formData.termMonths, "Term months");
            const amount = schedule.length > 0 ? schedule[0].amount : undefined;

            const draft = await api.post("/loans", {
                borrowerPublicId: formData.borrowerId,
                bankLoanPublicId: isTenantAdmin && formData.bankLoanId ? formData.bankLoanId : undefined,
                principal: toPublicMoney(formData.principal),
                interestRate: toPublicMoney(formData.interestRate),
                repaymentType: formData.repaymentType,
                termMonths: toPositiveInteger(formData.termMonths, "Term months"),
                totalInstallments: total,
                installmentAmount: amount,
                startDate: formData.startDate
            });
            setDraftId(draft.data.publicId);
            setStep(4);
        } catch (error: unknown) {
            console.error("Failed to create loan", error);
            const apiError = error as { response?: { data?: { error?: string } } };
            setErrorMessage(apiError.response?.data?.error || t("loanWizard.errors.create", "Failed to create the loan agreement."));
        } finally {
            setSubmitting(false);
        }
    };

    const handleActivate = async () => {
        try {
            setSubmitting(true);
            setErrorMessage("");
            await api.post(`/loans/${draftId}/activate`);
            window.location.href = `/loans/${draftId}`;
        } catch (error: unknown) {
            const apiError = error as { response?: { data?: { error?: string } } };
            setErrorMessage(apiError.response?.data?.error || t("loanWizard.errors.activate"));
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
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 mt-0.5" />
                    <span>{errorMessage}</span>
                </div>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>
                        {step === 1 && t("loanWizard.steps.select", "Step 1: Select Borrower & Drawdown")}
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
                                        <option key={b.id} value={b.id}>
                                            {b.name} {b.idCardNumber ? `(${b.idCardNumber})` : ""}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="grid gap-2">
                                <label>{t("loanWizard.drawdown", "Funding Drawdown (Optional)")}</label>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={formData.bankLoanId}
                                    onChange={(e) => setFormData({ ...formData, bankLoanId: e.target.value })}
                                    disabled={loadingDependencies}
                                >
                                    <option value="">{t("loanWizard.noneDrawdown", "None (Unmatched / Own Capital)")}</option>
                                    {drawdowns.map((item) => (
                                        <option key={item.publicId} value={item.publicId}>
                                            #{item.id} {item.bankProfileId ? bankProfileNameById.get(item.bankProfileId) ?? "" : ""} ฿{Number(item.outstandingPrincipal ?? item.amount).toLocaleString(i18n.language)}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {selectedDrawdown && (
                                <div className="rounded-lg border bg-muted/30 p-4 text-sm">
                                    <div className="font-medium">{t("loanWizard.selectedDrawdown", "Selected drawdown")}</div>
                                    <div className="mt-1 text-muted-foreground">
                                        {t("loanWizard.source", "Source")}: {selectedDrawdownProfile?.name ?? t("loanWizard.unknownSource", "Unknown source")}
                                    </div>
                                    <div className="text-muted-foreground">
                                        {t("loanWizard.outstandingPrincipal", "Outstanding principal")}: ฿{Number(selectedDrawdown.outstandingPrincipal ?? 0).toLocaleString(i18n.language)}
                                    </div>
                                    <div className="text-muted-foreground">
                                        {t("loanWizard.nextDue", "Next due")}: {selectedDrawdown.nextDueDate || t("loanWizard.notScheduled", "Not scheduled")}
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    {step === 2 && (
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="grid gap-2">
                                <label>{t("loanWizard.principalAmount", "Principal Amount (฿)")}</label>
                                <Input type="number" value={formData.principal} onChange={(e) => setFormData({ ...formData, principal: e.target.value })} />
                            </div>
                            <div className="grid gap-2">
                                <label>{t("loanWizard.interestRate", "Interest Rate (% per year)")}</label>
                                <Input type="number" value={formData.interestRate} onChange={(e) => setFormData({ ...formData, interestRate: e.target.value })} />
                            </div>
                            <div className="grid gap-2">
                                <label>{t("loanWizard.termMonths", "Term (Months)")}</label>
                                <Input type="number" value={formData.termMonths} onChange={(e) => setFormData({ ...formData, termMonths: e.target.value })} />
                            </div>
                            <div className="grid gap-2">
                                <label>{t("loanWizard.repaymentType", "Repayment Type")}</label>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={formData.repaymentType}
                                    onChange={(e) => setFormData({ ...formData, repaymentType: e.target.value })}
                                >
                                    <option value="monthly">{t("loanWizard.repaymentOptions.monthly", "Monthly Installment")}</option>
                                    <option value="daily">{t("loanWizard.repaymentOptions.daily", "Daily Installment")}</option>
                                    <option value="weekly">{t("loanWizard.repaymentOptions.weekly", "Weekly Installment")}</option>
                                    <option value="floating">{t("loanWizard.repaymentOptions.floating", "Floating (No fixed schedule)")}</option>
                                </select>
                            </div>
                            <div className="grid gap-2">
                                <label>{t("loanWizard.startDate", "Start Date")}</label>
                                <Input type="date" value={formData.startDate} onChange={(e) => setFormData({ ...formData, startDate: e.target.value })} />
                            </div>
                        </div>
                    )}

                    {step === 3 && (
                        <div className="space-y-4">
                            <div className="rounded-md border p-4 text-sm">
                                <div className="font-medium">{t("loanWizard.fundingSetup", "Funding setup")}</div>
                                <div className="mt-1 text-muted-foreground">
                                    {formData.bankLoanId
                                        ? t("loanWizard.review.withDrawdown", { defaultValue: "This loan will be created against drawdown #{{id}}.", id: formData.bankLoanId })
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
                                                        <td className="p-2">{row.dueDate}</td>
                                                        <td className="p-2">฿{Number(row.amount).toLocaleString(i18n.language)}</td>
                                                        <td className="p-2 text-muted-foreground">{Number(row.principalComponent).toLocaleString(i18n.language)}</td>
                                                        <td className="p-2 text-destructive">{Number(row.interestComponent).toLocaleString(i18n.language)}</td>
                                                        <td className="p-2">{Number(row.remainingPrincipal).toLocaleString(i18n.language)}</td>
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
