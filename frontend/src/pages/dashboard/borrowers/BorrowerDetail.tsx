import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, History, MapPin, Phone, Plus, Power } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "../../../components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";

interface Borrower {
    publicId: string;
    name: string;
    phone?: string | null;
    idCardNumber?: string | null;
    address?: string | null;
    googleMapsUrl?: string | null;
    photoUrl?: string | null;
    creditScore?: number | null;
    tags?: string[] | null;
}

interface Alias {
    publicId: string;
    alias: string;
    normalizedAlias: string;
    source: string;
    status: "pending" | "confirmed" | "inactive";
    confirmedAt?: string | null;
    createdAt: string;
    updatedAt: string;
}

interface Loan {
    publicId: string;
    principal: string;
    repaymentType: string;
    status: string;
    startDate: string;
}

interface Portfolio { borrower: Borrower; aliases: Alias[]; loans: Loan[] }
interface AuditEntry { id: number; entityType: string; entityId: string; action: string; requestId?: string | null; correlationId?: string | null; createdAt: string }

function initials(name: string) {
    return name.split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join("").toUpperCase() || "U";
}

export default function BorrowerDetail() {
    const { id = "" } = useParams();
    const navigate = useNavigate();
    const { t, i18n } = useTranslation();
    const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
    const [audits, setAudits] = useState<AuditEntry[]>([]);
    const [newAlias, setNewAlias] = useState("");
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const dateTime = useCallback((value: string) => new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium", timeStyle: "short",
    }).format(new Date(value)), [i18n.language]);
    const money = useCallback((value: string) => new Intl.NumberFormat(i18n.language, {
        style: "currency", currency: "THB", minimumFractionDigits: 2,
    }).format(Number(value)), [i18n.language]);

    const load = useCallback(async () => {
        const response = await api.get(`/borrowers/${id}/portfolio`);
        const next = response.data as Portfolio;
        setPortfolio(next);
        try {
            const histories = await Promise.all([
                api.get("/audit-logs", { params: { entityType: "borrower", entityId: id } }),
                ...next.aliases.map((alias) => api.get("/audit-logs", { params: { entityType: "borrower_alias", entityId: alias.publicId } })),
            ]);
            setAudits(histories.flatMap((item) => item.data ?? []).sort((a: AuditEntry, b: AuditEntry) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
        } catch {
            setAudits([]);
        }
    }, [id]);

    useEffect(() => {
        void load().catch(() => setError(t("borrowerDetail.errors.load"))).finally(() => setLoading(false));
    }, [load, t]);

    const mutate = async (operation: () => Promise<unknown>) => {
        setBusy(true);
        setError("");
        try { await operation(); await load(); }
        catch (caught: unknown) {
            const apiError = caught as { response?: { data?: { error?: string } } };
            setError(apiError.response?.data?.error ?? t("borrowerDetail.errors.alias"));
        } finally { setBusy(false); }
    };

    if (loading) return <div>{t("common.loading")}</div>;
    if (!portfolio) return <div>{error || t("borrowerDetail.notFound")}</div>;
    const { borrower, aliases, loans } = portfolio;

    return (
        <div className="space-y-6">
            <div className="border-b pb-5">
                <Link to="/borrowers" className="mb-4 flex items-center text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="mr-1 h-4 w-4" />{t("borrowerDetail.back")}</Link>
                <div className="flex items-center gap-5"><Avatar className="h-20 w-20"><AvatarImage src={borrower.photoUrl ?? undefined} /><AvatarFallback>{initials(borrower.name)}</AvatarFallback></Avatar><div><h1 className="text-3xl font-bold">{borrower.name}</h1><div className="mt-2 flex flex-wrap gap-2">{borrower.tags?.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}<Badge variant="outline" className="font-mono">{borrower.publicId}</Badge></div></div></div>
            </div>
            {error && <div className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
            <div className="grid gap-5 md:grid-cols-3">
                <Card className="md:col-span-2"><CardHeader><CardTitle>{t("borrowerDetail.contact")}</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2"><div className="flex gap-3"><Phone className="h-5 w-5 text-muted-foreground" /><div><div className="text-sm font-medium">{t("borrowers.phone")}</div><div className="text-muted-foreground">{borrower.phone || "—"}</div></div></div><div><div className="text-sm font-medium">{t("borrowerDetail.idCard")}</div><div className="text-muted-foreground">{borrower.idCardNumber || "—"}</div></div><div className="flex gap-3 sm:col-span-2"><MapPin className="h-5 w-5 text-muted-foreground" /><div><div className="text-sm font-medium">{t("borrowerDetail.address")}</div><div className="text-muted-foreground">{borrower.address || "—"}</div>{borrower.googleMapsUrl && <a href={borrower.googleMapsUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center text-xs text-primary">{t("borrowerDetail.openMaps")}<ArrowUpRight className="ml-1 h-3 w-3" /></a>}</div></div></CardContent></Card>
                <Card><CardHeader><CardTitle>{t("borrowerDetail.creditProfile")}</CardTitle></CardHeader><CardContent className="space-y-3"><div className="rounded bg-muted/30 p-4 text-center"><div className="text-3xl font-bold text-primary">{borrower.creditScore ?? "—"}</div><div className="text-sm text-muted-foreground">{t("borrowers.creditScore")}</div></div><div className="flex justify-between text-sm"><span>{t("borrowerDetail.activeLoans")}</span><strong>{loans.filter((loan) => loan.status === "active").length}</strong></div><div className="flex justify-between text-sm"><span>{t("borrowerDetail.totalLoans")}</span><strong>{loans.length}</strong></div></CardContent></Card>
            </div>
            <Tabs defaultValue="loans">
                <TabsList><TabsTrigger value="loans">{t("dashboard.loans")} ({loans.length})</TabsTrigger><TabsTrigger value="aliases">{t("borrowerDetail.aliases.title")} ({aliases.length})</TabsTrigger><TabsTrigger value="history">{t("borrowerDetail.history.title")}</TabsTrigger></TabsList>
                <TabsContent value="loans" className="space-y-3">{loans.map((loan) => <button key={loan.publicId} onClick={() => navigate(`/loans/${loan.publicId}`)} className="flex w-full items-center justify-between rounded border p-4 text-left hover:bg-muted/30"><div><div className="font-medium">{t("borrowerDetail.loanLabel", { id: loan.publicId.slice(0, 8) })}</div><div className="text-sm text-muted-foreground">{money(loan.principal)} · {t(`loanWizard.repaymentOptions.${loan.repaymentType}`)}</div></div><Badge>{loan.status}</Badge></button>)}{!loans.length && <div className="rounded border border-dashed p-8 text-center text-muted-foreground">{t("borrowerDetail.noLoans")}</div>}</TabsContent>
                <TabsContent value="aliases"><Card><CardHeader><CardTitle>{t("borrowerDetail.aliases.title")}</CardTitle></CardHeader><CardContent className="space-y-4"><div className="flex gap-2"><Input value={newAlias} placeholder={t("borrowerDetail.aliases.placeholder")} onChange={(event) => setNewAlias(event.target.value)} /><Button disabled={busy || !newAlias.trim()} onClick={() => void mutate(async () => { await api.post(`/borrowers/${id}/aliases`, { alias: newAlias.trim(), source: "manual" }); setNewAlias(""); })}><Plus className="mr-2 h-4 w-4" />{t("common.add")}</Button></div>{aliases.map((alias) => <div key={alias.publicId} className="flex flex-wrap items-center justify-between gap-3 rounded border p-3"><div><div className="font-medium">{alias.alias}<Badge className="ml-2" variant={alias.status === "confirmed" ? "default" : "secondary"}>{t(`borrowerDetail.aliases.status.${alias.status}`)}</Badge></div><div className="text-xs text-muted-foreground">{alias.normalizedAlias} · {t(`borrowerDetail.aliases.source.${alias.source}`)} · {dateTime(alias.updatedAt)}</div><div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{alias.publicId}</div></div><div className="flex gap-2">{alias.status !== "confirmed" && <Button size="sm" disabled={busy} onClick={() => void mutate(() => api.post(`/borrowers/aliases/${alias.publicId}/confirm`))}><Check className="mr-1 h-4 w-4" />{t("borrowerDetail.aliases.confirm")}</Button>}{alias.status !== "inactive" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate(() => api.post(`/borrowers/aliases/${alias.publicId}/deactivate`))}><Power className="mr-1 h-4 w-4" />{t("borrowerDetail.aliases.deactivate")}</Button>}</div></div>)}{!aliases.length && <div className="text-sm text-muted-foreground">{t("borrowerDetail.aliases.empty")}</div>}</CardContent></Card></TabsContent>
                <TabsContent value="history"><Card><CardHeader><CardTitle className="flex items-center gap-2"><History className="h-5 w-5" />{t("borrowerDetail.history.title")}</CardTitle></CardHeader><CardContent className="space-y-2">{audits.map((audit) => <div key={audit.id} className="rounded border p-3 text-sm"><div className="flex justify-between gap-3"><strong>{audit.action}</strong><span className="text-muted-foreground">{dateTime(audit.createdAt)}</span></div><div className="mt-1 break-all font-mono text-xs text-muted-foreground">{t("borrowerDetail.history.auditId")}: {audit.id} · {t("borrowerDetail.history.correlationId")}: {audit.correlationId || "—"} · {t("borrowerDetail.history.requestId")}: {audit.requestId || "—"}</div></div>)}{!audits.length && <div className="text-sm text-muted-foreground">{t("borrowerDetail.history.unavailable")}</div>}</CardContent></Card></TabsContent>
            </Tabs>
        </div>
    );
}
