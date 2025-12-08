import { useEffect, useState } from "react";
import axios from "axios";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Plus, FileText, Calendar } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../../../lib/utils";

export default function LoanList() {
    const [loans, setLoans] = useState<any[]>([]);

    useEffect(() => {
        const fetchLoans = async () => {
            try {
                const res = await axios.get("http://localhost:3000/loans");
                setLoans(res.data);
            } catch (error) {
                console.error("Failed to load loans");
            }
        };
        fetchLoans();
    }, []);

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Loan Agreements</h2>
                    <p className="text-muted-foreground">Manage active contracts and track repayments.</p>
                </div>
                <Link to="/dashboard/loans/new">
                    <Button>
                        <Plus className="mr-2 h-4 w-4" /> New Loan
                    </Button>
                </Link>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {loans.map((loan) => (
                    <Card key={loan.id} className="hover:shadow-md transition-shadow">
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <CardTitle className="text-sm font-medium">Loan #{loan.id}</CardTitle>
                            <div className={cn(
                                "rounded-full px-2 py-1 text-xs font-semibold",
                                loan.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700"
                            )}>
                                {loan.status.toUpperCase()}
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold mb-2">฿{Number(loan.principal).toLocaleString()}</div>
                            <p className="text-sm text-muted-foreground mb-4">{loan.borrowerName}</p>

                            <div className="flex items-center text-sm text-muted-foreground">
                                <Calendar className="mr-2 h-4 w-4" />
                                {new Date(loan.createdAt).toLocaleDateString()}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {loans.length === 0 && (
                <div className="flex flex-col items-center justify-center p-12 border-2 border-dashed rounded-lg bg-muted/50">
                    <FileText className="h-10 w-10 text-muted-foreground mb-4" />
                    <h3 className="text-lg font-medium">No Loans Found</h3>
                    <p className="text-sm text-muted-foreground mb-4">Create your first loan agreement to get started.</p>
                    <Link to="/dashboard/loans/new">
                        <Button variant="outline">Create Loan</Button>
                    </Link>
                </div>
            )}
        </div>
    );
}
