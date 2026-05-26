import React, { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import { Check, X, Eye, FileText, UploadCloud, RotateCcw } from "lucide-react";

// Mock Data
const PENDING_SLIPS = [
    {
        id: "slip-101",
        uploadedAt: "2025-12-16T10:30:00",
        imageUrl: "https://via.placeholder.com/400x800.png?text=Bank+Slip+1",
        amountStr: "400.00",
        expectedMatch: {
            borrowerName: "Somchai Jai-dee",
            loanId: "L-2025-001",
            expectedAmount: 400,
            dueDate: "2025-12-16"
        },
        status: "pending"
    },
    {
        id: "slip-102",
        uploadedAt: "2025-12-16T11:15:00",
        imageUrl: "https://via.placeholder.com/400x800.png?text=Bank+Slip+2",
        amountStr: "1,200.00",
        expectedMatch: {
            borrowerName: "Manee Rak-thai",
            loanId: "L-2025-042",
            expectedAmount: 1200,
            dueDate: "2025-12-16"
        },
        status: "pending"
    }
];

export default function SmartSlipQueue() {
    const [slips, setSlips] = useState(PENDING_SLIPS);
    const [currentIndex, setCurrentIndex] = useState(0);

    const currentSlip = slips[currentIndex];

    const handleAction = (id: string, action: "confirm" | "reject") => {
        // Optimistic UI update
        const updated = slips.map(s => s.id === id ? { ...s, status: action === "confirm" ? "matched" : "discarded" } : s);
        setSlips(updated);

        // Move to next pending
        const nextIndex = updated.findIndex(s => s.status === "pending");
        if (nextIndex !== -1) {
            setCurrentIndex(nextIndex);
        }
    };

    if (!currentSlip || currentSlip.status !== "pending") {
        return (
            <div className="flex flex-col items-center justify-center h-[60vh] text-center space-y-4">
                <div className="h-24 w-24 bg-primary/10 rounded-full flex items-center justify-center">
                    <Check className="h-12 w-12 text-primary" />
                </div>
                <h2 className="text-2xl font-bold">All caught up!</h2>
                <p className="text-muted-foreground">There are no more slips waiting for verification.</p>
                <Button onClick={() => setSlips(PENDING_SLIPS.map(s => ({...s, status: "pending"})))} variant="outline">
                    <RotateCcw className="mr-2 h-4 w-4" /> Reset Mock Data
                </Button>
            </div>
        );
    }

    const match = currentSlip.expectedMatch;
    const isExactMatch = parseFloat(currentSlip.amountStr.replace(/,/g, '')) === match?.expectedAmount;

    return (
        <div className="space-y-6 max-w-6xl mx-auto p-4 md:p-0">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-bold tracking-tight">Smart Slip Verification</h2>
                    <p className="text-muted-foreground text-sm">Review uploaded bank slips and match them to expected payments.</p>
                </div>
                <Badge variant="secondary" className="text-lg py-1 px-3">
                    {slips.filter(s => s.status === "pending").length} Pending
                </Badge>
            </div>

            <div className="grid md:grid-cols-2 gap-6 items-start">
                {/* LEFT: SLIP IMAGE */}
                <Card className="overflow-hidden border-2 shadow-sm">
                    <CardHeader className="bg-muted/50 border-b py-3">
                        <CardTitle className="text-sm font-medium flex items-center justify-between">
                            <span className="flex items-center"><UploadCloud className="h-4 w-4 mr-2"/> Uploaded Slip</span>
                            <span className="text-xs text-muted-foreground">{new Date(currentSlip.uploadedAt).toLocaleString()}</span>
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0 bg-black/5 flex justify-center items-center min-h-[500px]">
                        <img
                            src={currentSlip.imageUrl}
                            alt="Bank Slip"
                            className="max-h-[600px] object-contain shadow-md"
                        />
                    </CardContent>
                </Card>

                {/* RIGHT: EXPECTED MATCH */}
                <div className="space-y-6 sticky top-20">
                    <Card className="border-2 shadow-sm">
                        <CardHeader className="bg-primary/5 border-b py-4">
                            <CardTitle className="flex items-center text-lg">
                                <FileText className="h-5 w-5 mr-2 text-primary"/>
                                Expected Match
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="p-6 space-y-6">
                            {match ? (
                                <>
                                    <div className="flex justify-between items-end border-b pb-4">
                                        <div>
                                            <p className="text-sm text-muted-foreground font-medium uppercase tracking-wider mb-1">Borrower</p>
                                            <p className="text-xl font-bold">{match.borrowerName}</p>
                                            <p className="text-sm text-muted-foreground font-mono mt-1">{match.loanId}</p>
                                        </div>
                                        <Button size="icon" variant="ghost" className="rounded-full h-8 w-8"><Eye className="h-4 w-4"/></Button>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="bg-muted/30 p-4 rounded-xl border">
                                            <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-semibold">Slip Amount</p>
                                            <p className="text-2xl font-bold font-mono tracking-tight">฿{currentSlip.amountStr}</p>
                                        </div>
                                        <div className={`p-4 rounded-xl border ${isExactMatch ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
                                            <p className={`text-xs mb-1 uppercase tracking-wider font-semibold ${isExactMatch ? 'text-green-700' : 'text-yellow-700'}`}>
                                                Expected Amount
                                            </p>
                                            <p className={`text-2xl font-bold font-mono tracking-tight ${isExactMatch ? 'text-green-700' : 'text-yellow-700'}`}>
                                                ฿{match.expectedAmount.toLocaleString('en-US', {minimumFractionDigits: 2})}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex justify-between items-center text-sm p-3 bg-muted/20 rounded-lg">
                                        <span className="text-muted-foreground font-medium">Due Date:</span>
                                        <span className="font-semibold">{new Date(match.dueDate).toLocaleDateString()}</span>
                                    </div>
                                </>
                            ) : (
                                <div className="text-center py-10 text-muted-foreground">
                                    <p>No automatic match found.</p>
                                    <Button variant="link" className="mt-2">Manually link to loan</Button>
                                </div>
                            )}
                        </CardContent>
                        <CardFooter className="bg-muted/30 p-4 flex gap-3 border-t">
                            <Button
                                variant="outline"
                                className="flex-1 h-12 text-destructive border-destructive/30 hover:bg-destructive hover:text-destructive-foreground transition-colors"
                                onClick={() => handleAction(currentSlip.id, "reject")}
                            >
                                <X className="mr-2 h-5 w-5" /> Reject
                            </Button>
                            <Button
                                className="flex-1 h-12 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg transition-transform active:scale-95"
                                onClick={() => handleAction(currentSlip.id, "confirm")}
                            >
                                <Check className="mr-2 h-5 w-5" /> Confirm Match
                            </Button>
                        </CardFooter>
                    </Card>

                    <div className="flex justify-between items-center text-sm text-muted-foreground px-2">
                        <span>Queue progress:</span>
                        <span className="font-mono bg-muted px-2 py-1 rounded-md">{slips.findIndex(s => s.status === "pending") + 1} of {slips.filter(s => s.status === "pending").length + (slips.findIndex(s => s.status === "pending"))}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
