import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { api } from "../../../lib/api";
import { Loader2, Copy } from "lucide-react";

interface LoanClosingModalProps {
    loanId: number;
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
    const [summary, setSummary] = useState<ClosingSummary | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const fetchSummary = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        setSummary(null);
        try {
            const res = await api.get(`/loans/${loanId}/closing-summary`);
            setSummary(res.data);
        } catch (err) {
            setError("Failed to calculate closing summary.");
            console.error(err);
        } finally {
            setLoading(false);
        }
    }, [loanId]);

    useEffect(() => {
        if (open && loanId) {
            fetchSummary();
        }
    }, [open, loanId, fetchSummary]);

    const handleCopyToClipboard = () => {
        if (summary?.balance) {
            navigator.clipboard.writeText(summary.balance.toFixed(2));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Loan #{loanId} Closing Summary</DialogTitle>
                    <DialogDescription>
                        This is the calculated balance to close the loan as of today.
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
                            <span className="text-muted-foreground">Principal</span>
                            <span className="font-mono">฿{summary.principal.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground">Total Interest Accrued ({summary.daysSinceStart} days)</span>
                            <span className="font-mono text-blue-500">+ ฿{summary.totalInterest.toLocaleString()}</span>
                        </div>
                         <div className="flex justify-between items-center border-t pt-4">
                            <span className="text-muted-foreground">Total Amount Due</span>
                            <span className="font-mono">฿{summary.totalDue.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground">Total Repaid</span>
                            <span className="font-mono text-green-500">- ฿{summary.totalPaid.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between items-center text-xl font-bold border-t pt-4">
                            <span>Final Closing Balance</span>
                            <span className="font-mono text-primary">฿{summary.balance.toLocaleString()}</span>
                        </div>
                    </div>
                )}
                
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        Close
                    </Button>
                     {summary && (
                        <Button onClick={handleCopyToClipboard}>
                            <Copy className="mr-2 h-4 w-4" />
                            {copied ? "Copied!" : "Copy Balance"}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
