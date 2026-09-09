import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Plus, Wallet, Building2, Trash2 } from "lucide-react";
import { Input } from "../../../components/ui/Input";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

interface BankProfile {
    id: number;
    publicId?: string;
    name: string;
    type: string;
    creditLimit: string | null;
    deployedPrincipal?: number;
    realizedSpread?: number;
    unrealizedSpread?: number;
    netCashPosition?: number;
    carryForwardAvailable?: number;
}

export default function FundList() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const [funds, setFunds] = useState<BankProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const [search, setSearch] = useState("");
    const [typeFilter, setTypeFilter] = useState("all");
    const [sortBy, setSortBy] = useState("name");

    // New Fund Form State
    const [isAdding, setIsAdding] = useState(false);
    const [newName, setNewName] = useState("");
    const [newLimit, setNewLimit] = useState("");
    const [newType, setNewType] = useState("bank");

    useEffect(() => {
        fetchFunds();
    }, []);

    const visibleFunds = useMemo(() => {
        const searchText = search.trim().toLowerCase();
        const filtered = funds.filter((fund) => {
            const matchesSearch = !searchText || fund.name.toLowerCase().includes(searchText);
            const matchesType = typeFilter === "all" || fund.type === typeFilter;
            return matchesSearch && matchesType;
        });

        return filtered.sort((a, b) => {
            if (sortBy === "name") return a.name.localeCompare(b.name);
            if (sortBy === "net_cash_desc") return Number(b.netCashPosition ?? 0) - Number(a.netCashPosition ?? 0);
            if (sortBy === "spread_desc") return Number(b.realizedSpread ?? 0) - Number(a.realizedSpread ?? 0);
            if (sortBy === "deployed_desc") return Number(b.deployedPrincipal ?? 0) - Number(a.deployedPrincipal ?? 0);
            return 0;
        });
    }, [funds, search, sortBy, typeFilter]);

    const fetchFunds = async () => {
        try {
            const res = await api.get("/bank-profiles");
            const rawFunds: BankProfile[] = res.data ?? [];
            const enrichedFunds = await Promise.all(
                rawFunds.map(async (fund) => {
                    const profitabilityKey = fund.publicId ?? fund.id;
                    const profitabilityRes = await api.get(`/bank-profiles/${profitabilityKey}/profitability`);
                    return {
                        ...fund,
                        deployedPrincipal: Number(profitabilityRes.data?.deployedPrincipal ?? 0),
                        realizedSpread: Number(profitabilityRes.data?.realizedSpread ?? 0),
                        unrealizedSpread: Number(profitabilityRes.data?.unrealizedSpread ?? 0),
                        netCashPosition: Number(profitabilityRes.data?.netCashPosition ?? 0),
                        carryForwardAvailable: Number(profitabilityRes.data?.carryForwardAvailable ?? 0),
                    };
                })
            );
            setFunds(enrichedFunds);
            setErrorMessage("");
        } catch (error) {
            console.error("Failed to fetch funds", error);
            setErrorMessage(t("funds.errors.load", "Unable to load funding sources right now."));
        } finally {
            setLoading(false);
        }
    };

    const resetCreateForm = () => {
        setIsAdding(false);
        setNewName("");
        setNewLimit("");
        setNewType("bank");
    };

    const handleCreate = async (event?: FormEvent<HTMLFormElement>) => {
        event?.preventDefault();

        if (!newName.trim()) {
            setErrorMessage(t("funds.errors.missingName", "Please enter a fund name before saving."));
            return;
        }

        try {
            setSubmitting(true);
            setErrorMessage("");
            await api.post("/bank-profiles", {
                name: newName.trim(),
                type: newType,
                creditLimit: newLimit || "0",
                accountingMode: newType === "personal" ? "capital_pool" : "external_liability",
                opportunityCostRate: newType === "personal" ? "2.00" : "0.00",
            });
            resetCreateForm();
            await fetchFunds();
        } catch (error) {
            console.error("Failed to create fund", error);
            setErrorMessage(t("funds.errors.create", "Failed to create the funding source. Please try again."));
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (id: string | number) => {
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
                <Button
                    type="button"
                    onClick={() => {
                        setIsAdding((value) => !value);
                        setErrorMessage("");
                    }}
                >
                    <Plus className="mr-2 h-4 w-4" /> {t("funds.add_source")}
                </Button>
            </div>

            {errorMessage && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {errorMessage}
                </div>
            )}

            <Card>
                <CardContent className="grid gap-3 pt-6 md:grid-cols-2 xl:grid-cols-3">
                    <div className="grid gap-1.5">
                        <label className="text-sm font-medium">{t("common.search", "Search")}</label>
                        <Input placeholder={t("funds.searchPlaceholder", "Fund name")} value={search} onChange={(event) => setSearch(event.target.value)} />
                    </div>
                    <div className="grid gap-1.5">
                        <label className="text-sm font-medium">{t("funds.type")}</label>
                        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                            <option value="all">{t("funds.filters.allTypes", "All types")}</option>
                            <option value="bank">{t("funds.filters.bank", "Bank")}</option>
                            <option value="personal">{t("funds.filters.personal", "Personal")}</option>
                            <option value="investor">{t("funds.filters.investor", "Investor")}</option>
                        </select>
                    </div>
                    <div className="grid gap-1.5">
                        <label className="text-sm font-medium">{t("common.sort", "Sort")}</label>
                        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                            <option value="name">{t("common.name", "Name")}</option>
                            <option value="net_cash_desc">{t("funds.sort.netCash", "Highest net cash")}</option>
                            <option value="spread_desc">{t("funds.sort.realizedSpread", "Highest realized spread")}</option>
                            <option value="deployed_desc">{t("funds.sort.deployed", "Highest deployed")}</option>
                        </select>
                    </div>
                </CardContent>
            </Card>

            {isAdding && (
                <Card className="border-dashed">
                    <CardHeader>
                        <CardTitle className="text-lg">{t("funds.new_source")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <form className="flex gap-4 items-end" onSubmit={handleCreate}>
                            <div className="grid w-full items-center gap-1.5">
                                <label className="text-sm font-medium">{t("funds.source_name")}</label>
                                <Input
                                    placeholder={t("funds.exampleName", "e.g. SCB Speedy Cash")}
                                    value={newName}
                                    onChange={e => setNewName(e.target.value)}
                                />
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
                                    <option value="investor">{t("funds.filters.externalInvestor", "External Investor")}</option>
                                </select>
                            </div>
                            <div className="grid w-full items-center gap-1.5">
                                <label className="text-sm font-medium">{t("funds.max_amount")}</label>
                                <Input type="number" placeholder="0.00" value={newLimit} onChange={e => setNewLimit(e.target.value)} />
                            </div>
                            <Button type="submit" disabled={submitting}>
                                {submitting ? t("common.saving", "Saving...") : t("common.save")}
                            </Button>
                            <Button type="button" variant="outline" onClick={resetCreateForm} disabled={submitting}>
                                {t("common.cancel", "Cancel")}
                            </Button>
                        </form>
                    </CardContent>
                </Card>
            )}

            {loading ? (
                <div>{t("common.loading")}</div>
            ) : visibleFunds.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed rounded-xl bg-muted/20">
                    <div className="bg-background p-4 rounded-full shadow-sm mb-4">
                        <Wallet className="h-12 w-12 text-muted-foreground/50" />
                    </div>
                    <h3 className="text-xl font-semibold">{t("funds.no_funds", "No Sources Found")}</h3>
                    <p className="text-muted-foreground mt-2 max-w-sm mx-auto">
                        {t("funds.no_funds_desc", "You haven't added any funding sources yet. Add a bank account or personal capital to start tracking.")}
                    </p>
                    <Button
                        type="button"
                        onClick={() => {
                            setIsAdding(true);
                            setErrorMessage("");
                        }}
                        className="mt-6"
                        variant="outline"
                    >
                        <Plus className="mr-2 h-4 w-4" /> {t("funds.add_source")}
                    </Button>
                </div>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {visibleFunds.map((fund) => (
                        <Card
                            key={fund.id}
                            className="cursor-pointer transition-all hover:shadow-md hover:border-primary/50 group"
                            onClick={() => navigate(`/funds/${fund.publicId ?? fund.id}`)}
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
                                    {t("funds.limit")}: ฿{Number(fund.creditLimit).toLocaleString(i18n.language)}
                                </p>
                                <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                                    <div>
                                        <div className="text-muted-foreground">{t("funds.metrics.deployed", "Deployed")}</div>
                                        <div className="font-medium">฿{Number(fund.deployedPrincipal ?? 0).toLocaleString(i18n.language)}</div>
                                    </div>
                                    <div>
                                        <div className="text-muted-foreground">{t("funds.metrics.carryForward", "Carry-forward")}</div>
                                        <div className="font-medium">฿{Number(fund.carryForwardAvailable ?? 0).toLocaleString(i18n.language)}</div>
                                    </div>
                                    <div>
                                        <div className="text-muted-foreground">{t("funds.metrics.realizedSpread", "Realized spread")}</div>
                                        <div className={`font-medium ${Number(fund.realizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                                            ฿{Number(fund.realizedSpread ?? 0).toLocaleString(i18n.language)}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-muted-foreground">{t("funds.metrics.netCash", "Net cash")}</div>
                                        <div className={`font-medium ${Number(fund.netCashPosition ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                                            ฿{Number(fund.netCashPosition ?? 0).toLocaleString(i18n.language)}
                                        </div>
                                    </div>
                                </div>
                                <div className="mt-4 flex justify-between items-center">
                                    <span className="text-xs font-medium text-primary">{t("funds.view_details")} &rarr;</span>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleDelete(fund.publicId ?? fund.id);
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
