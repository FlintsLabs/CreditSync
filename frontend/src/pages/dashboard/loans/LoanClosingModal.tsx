import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/Button";
import { api } from "../../../lib/api";
import { Loader2, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";

interface LoanClosingModalProps {
    loanId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

interface ClosingSummary {
    principal: number;
    totalInterest: number;
    totalPaid: number;
    totalDue: number;
    balance: number;
    daysSinceStart: number;
}

export function LoanClosingModal({ loanId, open, onOpenChange }: LoanClosingModalProps) {
    const { t, i18n } = useTranslation();
    const [summary, setSummary] = useState<ClosingSummary | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (open && loanId) {
            fetchSummary();
        }
    }, [open, loanId]);

    const fetchSummary = async () => {
        setLoading(true);
        setError(null);
        setSummary(null);
        try {
            const res = await api.get(`/loans/${loanId}/closing-summary`);
            setSummary(res.data);
        } catch (err) {
            setError(t("loanClosing.errors.calculate", "Failed to calculate closing summary."));
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleCopyToClipboard = () => {
        if (summary) {
            const amount = summary.balance.toLocaleString(i18n.language, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
            });
            const message = t("loanClosing.copyMessage", {
                defaultValue: "Closing balance as of today is ฿{{amount}}.",
                amount,
            });
            navigator.clipboard.writeText(message);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("loanClosing.title", { defaultValue: "Loan #{{id}} Closing Summary", id: loanId })}</DialogTitle>
                    <DialogDescription>
                        {t("loanClosing.description", "This is the calculated balance to close the loan as of today.")}
                    </DialogDescription>
                </DialogHeader>
                
                {loading && (
                    <div className="flex items-center justify-center p-8">
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                )}

                {error && <div className="text-red-500 p-4">{error}</div>}

                {summary && (
                    <div className="space-y-4 py-4">
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground">{t("loanWizard.columns.principal", "Principal")}</span>
                            <span className="font-mono">฿{summary.principal.toLocaleString(i18n.language)}</span>
                        </div>
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground">{t("loanClosing.totalInterestAccrued", { defaultValue: "Total Interest Accrued ({{days}} days)", days: summary.daysSinceStart })}</span>
                            <span className="font-mono text-blue-500">+ ฿{summary.totalInterest.toLocaleString(i18n.language)}</span>
                        </div>
                         <div className="flex justify-between items-center border-t pt-4">
                            <span className="text-muted-foreground">{t("loanClosing.totalAmountDue", "Total Amount Due")}</span>
                            <span className="font-mono">฿{summary.totalDue.toLocaleString(i18n.language)}</span>
                        </div>
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground">{t("loanClosing.totalRepaid", "Total Repaid")}</span>
                            <span className="font-mono text-green-500">- ฿{summary.totalPaid.toLocaleString(i18n.language)}</span>
                        </div>
                        <div className="flex justify-between items-center text-xl font-bold border-t pt-4">
                            <span>{t("loanClosing.finalBalance", "Final Closing Balance")}</span>
                            <span className="font-mono text-primary">฿{summary.balance.toLocaleString(i18n.language)}</span>
                        </div>
                    </div>
                )}
                
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {t("common.close", "Close")}
                    </Button>
                     {summary && (
                        <Button onClick={handleCopyToClipboard}>
                            <Copy className="mr-2 h-4 w-4" />
                            {copied ? t("loanClosing.copied", "Copied!") : t("loanClosing.copyMessageButton", "Copy Message")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
