import { useState, useEffect } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/card";
import { ChevronRight, ChevronLeft, CheckCircle } from "lucide-react";

export default function LoanWizard() {
    const [step, setStep] = useState(1);
    const [borrowers, setBorrowers] = useState<any[]>([]);
    const [funds, setFunds] = useState<any[]>([]);

    // Form State
    const [formData, setFormData] = useState({
        borrowerId: "",
        bankLoanId: "",
        principal: "",
        interestRate: "15", // Default
        termMonths: "12",
        repaymentType: "monthly",
        startDate: new Date().toISOString().split('T')[0]
    });

    const [schedule, setSchedule] = useState<any[]>([]);

    useEffect(() => {
        // Fetch Dependencies
        api.get("/borrowers").then(res => setBorrowers(res.data));
        api.get("/bank-profiles").then(res => setFunds(res.data));
    }, []);

    const calculateSchedule = async () => {
        try {
            const res = await api.post("/loans/calculate", {
                principal: Number(formData.principal),
                interestRate: Number(formData.interestRate),
                termMonths: Number(formData.termMonths),
                repaymentType: formData.repaymentType,
                startDate: formData.startDate
            });
            setSchedule(res.data);
            return true;
        } catch (error) {
            alert("Calculation failed");
            return false;
        }
    };

    const handleNext = async () => {
        if (step === 2) {
            const success = await calculateSchedule();
            if (success) setStep(3);
        } else {
            setStep(step + 1);
        }
    };

    const handleSubmit = async () => {
        try {
            // Find total installment from schedule
            const total = schedule.length;
            const amount = schedule.length > 0 ? schedule[0].amount : 0;

            await api.post("/loans", {
                borrowerId: Number(formData.borrowerId),
                bankLoanId: formData.bankLoanId ? Number(formData.bankLoanId) : undefined,
                principal: Number(formData.principal),
                interestRate: Number(formData.interestRate),
                repaymentType: formData.repaymentType,
                totalInstallments: total,
                installmentAmount: amount,
                startDate: formData.startDate
            });
            alert("Loan Created!");
            window.location.href = "/dashboard/loans";
        } catch (error) {
            alert("Failed to create loan");
        }
    };

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <h2 className="text-3xl font-bold">New Loan Agreement</h2>

            {/* Progress Bar */}
            <div className="flex gap-2">
                {[1, 2, 3].map(i => (
                    <div key={i} className={`h-2 flex-1 rounded-full ${step >= i ? 'bg-primary' : 'bg-muted'}`} />
                ))}
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>
                        {step === 1 && "Step 1: Select Borrower & Fund"}
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
                                    onChange={e => setFormData({ ...formData, borrowerId: e.target.value })}
                                >
                                    <option value="">Select Borrower...</option>
                                    {borrowers.map(b => (
                                        <option key={b.id} value={b.id}>{b.name} ({b.idCardNumber})</option>
                                    ))}
                                </select>
                            </div>
                            <div className="grid gap-2">
                                <label>Source of Fund (Optional)</label>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={formData.bankLoanId}
                                    onChange={e => setFormData({ ...formData, bankLoanId: e.target.value })}
                                >
                                    <option value="">None (Own Capital)</option>
                                    {funds.map(f => (
                                        <option key={f.id} value={f.id}>{f.name}</option>
                                    ))}
                                </select>
                            </div>
                        </>
                    )}

                    {step === 2 && (
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="grid gap-2">
                                <label>Principal Amount (฿)</label>
                                <Input type="number" value={formData.principal} onChange={e => setFormData({ ...formData, principal: e.target.value })} />
                            </div>
                            <div className="grid gap-2">
                                <label>Interest Rate (% per year)</label>
                                <Input type="number" value={formData.interestRate} onChange={e => setFormData({ ...formData, interestRate: e.target.value })} />
                            </div>
                            <div className="grid gap-2">
                                <label>Term (Months)</label>
                                <Input type="number" value={formData.termMonths} onChange={e => setFormData({ ...formData, termMonths: e.target.value })} />
                            </div>
                            <div className="grid gap-2">
                                <label>Repayment Type</label>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={formData.repaymentType}
                                    onChange={e => setFormData({ ...formData, repaymentType: e.target.value })}
                                >
                                    <option value="monthly">Monthly Installment</option>
                                    <option value="daily">Daily Installment</option>
                                    <option value="weekly">Weekly Installment</option>
                                    <option value="floating">Floating (Pay as you go)</option>
                                </select>
                            </div>
                            <div className="grid gap-2">
                                <label>Start Date</label>
                                <Input type="date" value={formData.startDate} onChange={e => setFormData({ ...formData, startDate: e.target.value })} />
                            </div>
                        </div>
                    )}

                    {step === 3 && (
                        <div className="space-y-4">
                            <div className="bg-muted p-4 rounded-md">
                                <h3 className="font-semibold mb-2">Installment Schedule Preview</h3>
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
                                            {schedule.map((row: any) => (
                                                <tr key={row.installmentNo} className="border-t">
                                                    <td className="p-2">{row.installmentNo}</td>
                                                    <td className="p-2">{row.dueDate}</td>
                                                    <td className="p-2">฿{row.amount.toLocaleString()}</td>
                                                    <td className="p-2 text-muted-foreground">{row.principalComponent}</td>
                                                    <td className="p-2 text-destructive">{row.interestComponent}</td>
                                                    <td className="p-2">{row.remainingPrincipal.toLocaleString()}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                            <div className="text-right text-sm text-muted-foreground">
                                * This is a preliminary schedule. Actual interest may vary based on exact payment dates.
                            </div>
                        </div>
                    )}

                    <div className="flex justify-between pt-4">
                        <Button variant="outline" onClick={() => setStep(step - 1)} disabled={step === 1}>
                            <ChevronLeft className="mr-2 h-4 w-4" /> Back
                        </Button>

                        {step < 3 ? (
                            <Button onClick={handleNext} disabled={!formData.borrowerId || (step === 2 && !formData.principal)}>
                                Next <ChevronRight className="ml-2 h-4 w-4" />
                            </Button>
                        ) : (
                            <Button onClick={handleSubmit} className="bg-green-600 hover:bg-green-700">
                                <CheckCircle className="mr-2 h-4 w-4" /> Create Loan Agreement
                            </Button>
                        )}
                    </div>

                </CardContent>
            </Card>
        </div>
    );
}
