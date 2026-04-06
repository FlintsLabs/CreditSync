import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { ChevronRight, ChevronLeft, CheckCircle, AlertCircle } from "lucide-react";

interface Borrower {
    id: number;
    name: string;
    idCardNumber?: string | null;
}

interface DrawdownOption {
    id: number;
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
    amount: number;
    principalComponent: number;
    interestComponent: number;
    remainingPrincipal: number;
}

export default function LoanWizard() {
    const [step, setStep] = useState(1);
    const [borrowers, setBorrowers] = useState<Borrower[]>([]);
    const [drawdowns, setDrawdowns] = useState<DrawdownOption[]>([]);
    const [bankProfiles, setBankProfiles] = useState<BankProfile[]>([]);
    const [loadingDependencies, setLoadingDependencies] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");

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
                    api.get("/bank-loans"),
                    api.get("/bank-profiles"),
                ]);
                setBorrowers(borrowersRes.data ?? []);
                setDrawdowns((drawdownsRes.data ?? []).filter((item: DrawdownOption) => item.status !== "closed"));
                setBankProfiles(profilesRes.data ?? []);
            } catch (error) {
                console.error("Failed to load loan wizard dependencies", error);
                setErrorMessage("Unable to load borrowers and funds right now.");
            } finally {
                setLoadingDependencies(false);
            }
        };

        loadDependencies();
    }, []);

    const selectedDrawdown = drawdowns.find((item) => String(item.id) === formData.bankLoanId);
    const selectedDrawdownProfile = bankProfiles.find((item) => item.id === selectedDrawdown?.bankProfileId);
    const bankProfileNameById = new Map(bankProfiles.map((item) => [item.id, item.name]));

    const calculateSchedule = async () => {
        try {
            const res = await api.post("/loans/calculate", {
                principal: Number(formData.principal),
                interestRate: Number(formData.interestRate),
                termMonths: Number(formData.termMonths),
                repaymentType: formData.repaymentType,
                startDate: formData.startDate
            });
            setSchedule(res.data ?? []);
            return true;
        } catch (error) {
            console.error("Calculation failed", error);
            setErrorMessage("Unable to calculate the borrower schedule.");
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

            const total = schedule.length || Number(formData.termMonths);
            const amount = schedule.length > 0 ? schedule[0].amount : 0;

            await api.post("/loans", {
                borrowerId: Number(formData.borrowerId),
                bankLoanId: formData.bankLoanId ? Number(formData.bankLoanId) : undefined,
                principal: Number(formData.principal),
                interestRate: Number(formData.interestRate),
                repaymentType: formData.repaymentType,
                termMonths: Number(formData.termMonths),
                totalInstallments: total,
                installmentAmount: amount,
                startDate: formData.startDate
            });

            window.location.href = "/dashboard/loans";
        } catch (error: any) {
            console.error("Failed to create loan", error);
            setErrorMessage(error?.response?.data?.error || "Failed to create the loan agreement.");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <h2 className="text-3xl font-bold">New Loan Agreement</h2>

            <div className="flex gap-2">
                {[1, 2, 3].map((i) => (
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
                        {step === 1 && "Step 1: Select Borrower & Drawdown"}
                        {step === 2 && "Step 2: Loan Terms"}
                        {step === 3 && "Step 3: Review & Confirm"}
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    {step === 1 && (
                        <>
                            <div className="grid gap-2">
                                <label>Borrower</label>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={formData.borrowerId}
                                    onChange={(e) => setFormData({ ...formData, borrowerId: e.target.value })}
                                    disabled={loadingDependencies}
                                >
                                    <option value="">Select Borrower...</option>
                                    {borrowers.map((b) => (
                                        <option key={b.id} value={b.id}>
                                            {b.name} {b.idCardNumber ? `(${b.idCardNumber})` : ""}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="grid gap-2">
                                <label>Funding Drawdown (Optional)</label>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={formData.bankLoanId}
                                    onChange={(e) => setFormData({ ...formData, bankLoanId: e.target.value })}
                                    disabled={loadingDependencies}
                                >
                                    <option value="">None (Unmatched / Own Capital)</option>
                                    {drawdowns.map((item) => (
                                        <option key={item.id} value={item.id}>
                                            #{item.id} {item.bankProfileId ? bankProfileNameById.get(item.bankProfileId) ?? "" : ""} ฿{Number(item.outstandingPrincipal ?? item.amount).toLocaleString()}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {selectedDrawdown && (
                                <div className="rounded-lg border bg-muted/30 p-4 text-sm">
                                    <div className="font-medium">Selected drawdown</div>
                                    <div className="mt-1 text-muted-foreground">
                                        Source: {selectedDrawdownProfile?.name ?? "Unknown source"}
                                    </div>
                                    <div className="text-muted-foreground">
                                        Outstanding principal: ฿{Number(selectedDrawdown.outstandingPrincipal ?? 0).toLocaleString()}
                                    </div>
                                    <div className="text-muted-foreground">
                                        Next due: {selectedDrawdown.nextDueDate || "Not scheduled"}
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    {step === 2 && (
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="grid gap-2">
                                <label>Principal Amount (฿)</label>
                                <Input type="number" value={formData.principal} onChange={(e) => setFormData({ ...formData, principal: e.target.value })} />
                            </div>
                            <div className="grid gap-2">
                                <label>Interest Rate (% per year)</label>
                                <Input type="number" value={formData.interestRate} onChange={(e) => setFormData({ ...formData, interestRate: e.target.value })} />
                            </div>
                            <div className="grid gap-2">
                                <label>Term (Months)</label>
                                <Input type="number" value={formData.termMonths} onChange={(e) => setFormData({ ...formData, termMonths: e.target.value })} />
                            </div>
                            <div className="grid gap-2">
                                <label>Repayment Type</label>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={formData.repaymentType}
                                    onChange={(e) => setFormData({ ...formData, repaymentType: e.target.value })}
                                >
                                    <option value="monthly">Monthly Installment</option>
                                    <option value="daily">Daily Installment</option>
                                    <option value="weekly">Weekly Installment</option>
                                    <option value="floating">Floating (No fixed schedule)</option>
                                </select>
                            </div>
                            <div className="grid gap-2">
                                <label>Start Date</label>
                                <Input type="date" value={formData.startDate} onChange={(e) => setFormData({ ...formData, startDate: e.target.value })} />
                            </div>
                        </div>
                    )}

                    {step === 3 && (
                        <div className="space-y-4">
                            <div className="rounded-md border p-4 text-sm">
                                <div className="font-medium">Funding setup</div>
                                <div className="mt-1 text-muted-foreground">
                                    {formData.bankLoanId
                                        ? `This loan will be created against drawdown #${formData.bankLoanId}.`
                                        : "This loan will be created without a matched drawdown and can be allocated later."}
                                </div>
                            </div>
                            <div className="bg-muted p-4 rounded-md">
                                <h3 className="font-semibold mb-2">Installment Schedule Preview</h3>
                                {schedule.length === 0 ? (
                                    <div className="text-sm text-muted-foreground">
                                        Floating repayment type has no fixed borrower schedule.
                                    </div>
                                ) : (
                                    <div className="max-h-60 overflow-y-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="text-left">
                                                    <th className="p-2">#</th>
                                                    <th className="p-2">Due Date</th>
                                                    <th className="p-2">Amount</th>
                                                    <th className="p-2">Principal</th>
                                                    <th className="p-2">Interest</th>
                                                    <th className="p-2">Balance</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {schedule.map((row) => (
                                                    <tr key={row.installmentNo} className="border-t">
                                                        <td className="p-2">{row.installmentNo}</td>
                                                        <td className="p-2">{row.dueDate}</td>
                                                        <td className="p-2">฿{Number(row.amount).toLocaleString()}</td>
                                                        <td className="p-2 text-muted-foreground">{Number(row.principalComponent).toLocaleString()}</td>
                                                        <td className="p-2 text-destructive">{Number(row.interestComponent).toLocaleString()}</td>
                                                        <td className="p-2">{Number(row.remainingPrincipal).toLocaleString()}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    <div className="flex justify-between pt-4">
                        <Button variant="outline" onClick={() => setStep(step - 1)} disabled={step === 1 || submitting}>
                            <ChevronLeft className="mr-2 h-4 w-4" /> Back
                        </Button>

                        {step < 3 ? (
                            <Button
                                onClick={handleNext}
                                disabled={loadingDependencies || !formData.borrowerId || (step === 2 && !formData.principal)}
                            >
                                Next <ChevronRight className="ml-2 h-4 w-4" />
                            </Button>
                        ) : (
                            <Button onClick={handleSubmit} className="bg-green-600 hover:bg-green-700" disabled={submitting}>
                                <CheckCircle className="mr-2 h-4 w-4" /> {submitting ? "Creating..." : "Create Loan Agreement"}
                            </Button>
                        )}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
