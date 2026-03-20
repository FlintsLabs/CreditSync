import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Plus, Wallet, Building2, Trash2 } from "lucide-react";
import { Input } from "../../../components/ui/Input";
import { useTranslation } from "react-i18next";

interface BankProfile {
    id: string;
    name: string;
    type: string;
    creditLimit: string | null;
}

export default function FundList() {
    const { t } = useTranslation();
    const [funds, setFunds] = useState<BankProfile[]>([]);
    const [loading, setLoading] = useState(true);

    // New Fund Form State
    const [isAdding, setIsAdding] = useState(false);
    const [newName, setNewName] = useState("");
    const [newLimit, setNewLimit] = useState("");
    const [newType, setNewType] = useState("bank");

    useEffect(() => {
        fetchFunds();
    }, []);

    const fetchFunds = async () => {
        try {
            const res = await api.get("/bank-profiles");
            setFunds(res.data);
        } catch (error) {
            console.error("Failed to fetch funds", error);
        } finally {
            setLoading(false);
        }
    };

    const handleCreate = async () => {
        if (!newName) return;
        try {
            await api.post("/bank-profiles", {
                name: newName,
                type: newType,
                creditLimit: newLimit || "0",
            });
            setIsAdding(false);
            setNewName("");
            setNewLimit("");
            fetchFunds();
        } catch (error) {
            console.error("Failed to create fund", error);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm(t("common.delete") + "?")) return;
        try {
            await api.delete(`/bank-profiles/${id}`);
            fetchFunds();
        } catch (error) {
            console.error("Failed to delete", error);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">{t("funds.title")}</h2>
                    <p className="text-muted-foreground">{t("funds.description")}</p>
                </div>
                <Button onClick={() => setIsAdding(!isAdding)}>
                    <Plus className="mr-2 h-4 w-4" /> {t("funds.add_source")}
                </Button>
            </div>

            {isAdding && (
                <Card className="border-dashed">
                    <CardHeader>
                        <CardTitle className="text-lg">{t("funds.new_source")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex gap-4 items-end">
                            <div className="grid w-full items-center gap-1.5">
                                <label className="text-sm font-medium">{t("funds.source_name")}</label>
                                <Input placeholder="e.g. SCB Speedy Cash" value={newName} onChange={e => setNewName(e.target.value)} />
                            </div>
                            <div className="grid w-full items-center gap-1.5">
                                <label className="text-sm font-medium">{t("funds.type")}</label>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={newType}
                                    onChange={e => setNewType(e.target.value)}
                                >
                                    <option value="bank">{t("funds.bank_credit")}</option>
                                    <option value="personal">{t("funds.capital")}</option>
                                    <option value="investor">External Investor</option>
                                </select>
                            </div>
                            <div className="grid w-full items-center gap-1.5">
                                <label className="text-sm font-medium">{t("funds.max_amount")}</label>
                                <Input type="number" placeholder="0.00" value={newLimit} onChange={e => setNewLimit(e.target.value)} />
                            </div>
                            <Button onClick={handleCreate}>{t("common.save")}</Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {loading ? (
                <div>{t("common.loading")}</div>
            ) : funds.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed rounded-xl bg-muted/20">
                    <div className="bg-background p-4 rounded-full shadow-sm mb-4">
                        <Wallet className="h-12 w-12 text-muted-foreground/50" />
                    </div>
                    <h3 className="text-xl font-semibold">{t("funds.no_funds", "No Sources Found")}</h3>
                    <p className="text-muted-foreground mt-2 max-w-sm mx-auto">
                        {t("funds.no_funds_desc", "You haven't added any funding sources yet. Add a bank account or personal capital to start tracking.")}
                    </p>
                    <Button onClick={() => setIsAdding(true)} className="mt-6" variant="outline">
                        <Plus className="mr-2 h-4 w-4" /> {t("funds.add_source")}
                    </Button>
                </div>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {funds.map((fund) => (
                        <Card
                            key={fund.id}
                            className="cursor-pointer transition-all hover:shadow-md hover:border-primary/50 group"
                            onClick={() => window.location.href = `/dashboard/funds/${fund.id}`}
                        >
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <CardTitle className="text-sm font-medium">
                                    {fund.type === 'bank' ? t("funds.bank_credit") : t("funds.capital")}
                                </CardTitle>
                                {fund.type === 'bank' ? (
                                    <Building2 className="h-8 w-8 text-primary/50" />
                                ) : (
                                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                                        <Wallet className="h-4 w-4" />
                                    </div>
                                )}
                            </CardHeader>
                            <CardContent>
                                <div className="text-2xl font-bold">{fund.name}</div>
                                <p className="text-xs text-muted-foreground">
                                    {t("funds.limit")}: ฿{Number(fund.creditLimit).toLocaleString()}
                                </p>
                                <div className="mt-4 flex justify-between items-center">
                                    <span className="text-xs font-medium text-primary">{t("funds.view_details")} &rarr;</span>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleDelete(fund.id);
                                        }}
                                        className="text-destructive hover:text-destructive h-8 w-8 p-0"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}
