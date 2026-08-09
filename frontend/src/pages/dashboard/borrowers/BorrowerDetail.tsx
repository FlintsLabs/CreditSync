import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api } from "../../../lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "../../../components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { MapPin, Phone, CreditCard, ArrowLeft, FileText, ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function BorrowerDetail() {
    const { t, i18n } = useTranslation();
    const { id } = useParams();
    const navigate = useNavigate();
    const [borrower, setBorrower] = useState<any>(null);
    const [loans, setLoans] = useState<any[]>([]);
    const [transactions, setTransactions] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            try {
                // Parallel fetch
                const [bRes, lRes, tRes] = await Promise.all([
                    api.get(`/borrowers/${id}`),
                    api.get("/loans"), // Optimized: should filter by borrowerId on backend in real app, filtering client side for now
                    api.get("/transactions")
                ]);

                setBorrower(bRes.data);

                // Client-side filtering as per current backend capabilities
                // Ideally backend should support /loans?borrowerId=...
                const bLoans = lRes.data.filter((l: any) => l.borrowerId === Number(id));
                setLoans(bLoans);

                // Filter transactions for these loans
                const loanIds = bLoans.map((l: any) => l.id);
                const bTrans = tRes.data.filter((t: any) => loanIds.includes(t.loanId));
                setTransactions(bTrans);

            } catch (error) {
                console.error("Failed to load details", error);
            } finally {
                setLoading(false);
            }
        };

        if (id) fetchData();
    }, [id]);

    const getInitials = (name: string) => {
        if (!name) return "U";
        return name.split(" ").map(n => n[0]).slice(0, 2).join("").toUpperCase();
    };

    if (loading) return <div>{t("common.loading", "Loading...")}</div>;
    if (!borrower) return <div>{t("borrowerDetail.notFound", "Borrower not found")}</div>;

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 py-4 -mx-6 px-6 border-b z-10">
                <Link to="/borrowers" className="text-muted-foreground hover:text-foreground flex items-center mb-4">
                    <ArrowLeft className="h-4 w-4 mr-1" /> {t("borrowerDetail.back", "Back to List")}
                </Link>
                <div className="flex items-center gap-6">
                    <Avatar className="h-24 w-24 border-4 border-white shadow-md">
                        <AvatarImage src={borrower.photoUrl} />
                        <AvatarFallback className="text-2xl bg-primary/20 text-primary font-bold">
                            {getInitials(borrower.name)}
                        </AvatarFallback>
                    </Avatar>
                    <div>
                        <h1 className="text-3xl font-bold">{borrower.name}</h1>
                        <div className="flex flex-wrap gap-2 mt-2">
                            {borrower.tags?.map((tag: string) => (
                                <Badge key={tag} variant="secondary">{tag}</Badge>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Info Grid */}
            <div className="grid gap-6 md:grid-cols-3">
                <Card className="md:col-span-2">
                    <CardHeader>
                        <CardTitle>{t("borrowerDetail.contact", "Contact Information")}</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4 sm:grid-cols-2">
                        <div className="flex items-center gap-3">
                            <Phone className="h-5 w-5 text-muted-foreground" />
                            <div>
                                <p className="text-sm font-medium">{t("borrowers.phone", "Phone")}</p>
                                <p className="text-muted-foreground">{borrower.phone || "-"}</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <CreditCard className="h-5 w-5 text-muted-foreground" />
                            <div>
                                <p className="text-sm font-medium">{t("borrowerDetail.idCard", "ID Card")}</p>
                                <p className="text-muted-foreground">{borrower.idCardNumber || "-"}</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-3 sm:col-span-2">
                            <MapPin className="h-5 w-5 text-muted-foreground" />
                            <div className="flex-1">
                                <p className="text-sm font-medium">{t("borrowerDetail.address", "Address")}</p>
                                <p className="text-muted-foreground">{borrower.address || "-"}</p>
                                {borrower.googleMapsUrl && (
                                    <a
                                        href={borrower.googleMapsUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-xs text-blue-500 hover:underline inline-flex items-center mt-1"
                                    >
                                        {t("borrowerDetail.openMaps", "Open in Google Maps")} <ArrowUpRight className="h-3 w-3 ml-1" />
                                    </a>
                                )}
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>{t("borrowerDetail.creditProfile", "Credit Profile")}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="text-center p-4 bg-muted/20 rounded-lg">
                            <div className="text-4xl font-bold text-primary">{borrower.creditScore}</div>
                            <div className="text-sm text-muted-foreground">{t("borrowers.creditScore", "Credit Score")}</div>
                        </div>
                        <div className="space-y-2">
                            <div className="flex justify-between text-sm">
                                <span>{t("borrowerDetail.activeLoans", "Active Loans")}</span>
                                <span className="font-medium">{loans.filter(l => l.status === 'active').length}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span>{t("borrowerDetail.totalLoans", "Total Loans")}</span>
                                <span className="font-medium">{loans.length}</span>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Tabs: Loans & Transactions */}
            <Tabs defaultValue="loans">
                <TabsList>
                    <TabsTrigger value="loans">{t("dashboard.loans", "Loans")} ({loans.length})</TabsTrigger>
                    <TabsTrigger value="transactions">{t("transactions.recordRepayment", "Repayments")} ({transactions.length})</TabsTrigger>
                    <TabsTrigger value="images">{t("borrowerDetail.documents", "Documents")}</TabsTrigger>
                </TabsList>

                <TabsContent value="loans" className="space-y-4">
                    {loans.length === 0 ? (
                        <div className="p-8 text-center text-muted-foreground border rounded-lg bg-muted/10">{t("borrowerDetail.noLoans", "No loans found.")}</div>
                    ) : (
                        loans.map((loan) => (
                            <Card key={loan.id} className="hover:bg-muted/10 transition-colors cursor-pointer" onClick={() => navigate(`/loans/${loan.publicId ?? loan.id}`)}>
                                <CardContent className="flex items-center justify-between p-6">
                                    <div className="flex items-center gap-4">
                                        <div className="p-2 bg-primary/10 rounded-full">
                                            <FileText className="h-6 w-6 text-primary" />
                                        </div>
                                        <div>
                                            <h3 className="font-semibold">{t("borrowerDetail.loanLabel", { defaultValue: "Loan #{{id}}", id: loan.id })}</h3>
                                            <p className="text-sm text-muted-foreground">
                                                {t("borrowerDetail.loanSummary", { defaultValue: "Principal: ฿{{principal}} • {{repaymentType}}", principal: Number(loan.principal).toLocaleString(i18n.language), repaymentType: loan.repaymentType })}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-4">
                                        <Badge variant={loan.status === 'active' ? 'default' : 'secondary'}>
                                            {loan.status.toUpperCase()}
                                        </Badge>
                                        <div className="text-right text-sm">
                                            <div className="text-muted-foreground">{t("borrowerDetail.startDate", "Start Date")}</div>
                                            <div>{new Date(loan.startDate).toLocaleDateString(i18n.language)}</div>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        ))
                    )}
                </TabsContent>

                <TabsContent value="transactions">
                    <div className="rounded-md border">
                        <table className="w-full text-sm">
                            <thead className="bg-muted/50">
                                <tr className="text-left border-b">
                                    <th className="p-3 font-medium">{t("transactions.columns.date", "Date")}</th>
                                    <th className="p-3 font-medium">{t("borrowerDetail.loanId", "Loan ID")}</th>
                                    <th className="p-3 font-medium">{t("transactions.columns.total", "Amount")}</th>
                                    <th className="p-3 font-medium">{t("transactions.columns.slip", "Slip")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {transactions.map((tx) => (
                                    <tr key={tx.id} className="border-b last:border-0 hover:bg-muted/10">
                                        <td className="p-3">{new Date(tx.date).toLocaleDateString(i18n.language)}</td>
                                        <td className="p-3">#{tx.loanId}</td>
                                        <td className="p-3 text-green-600 font-medium">+฿{Number(tx.amount).toLocaleString(i18n.language)}</td>
                                        <td className="p-3">
                                            {tx.slipUrl ? (
                                                <a href={tx.slipUrl} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">{t("common.view", "View")}</a>
                                            ) : "-"}
                                        </td>
                                    </tr>
                                ))}
                                {transactions.length === 0 && (
                                    <tr>
                                        <td colSpan={4} className="p-4 text-center text-muted-foreground">{t("borrowerDetail.noTransactions", "No transactions found.")}</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </TabsContent>

                <TabsContent value="images">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {borrower.idCardImageUrl && (
                            <div className="rounded-lg border overflow-hidden">
                                <img src={borrower.idCardImageUrl} alt={t("borrowerDetail.idCard", "ID Card")} className="w-full h-40 object-cover" />
                                <div className="p-2 text-xs font-medium bg-muted">{t("borrowerDetail.idCard", "ID Card")}</div>
                            </div>
                        )}
                        {/* Add more images if available */}
                    </div>
                </TabsContent>
            </Tabs>
        </div>
    );
}
