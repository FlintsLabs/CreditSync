import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Landmark } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { formatMoneyExact, sumMoney } from "../../../lib/workflow-model";
import { IntermediaryTransferLedger } from "./IntermediaryTransferLedger";
import { refreshForScope } from "./intermediary-scope";

type Assignment = {
    publicId: string; loanPublicId: string; loanStatus?: string; borrowerName?: string;
    role: "disbursement" | "collection" | "both"; effectiveFrom: string; effectiveTo: string | null;
    status: "active" | "ended"; note: string | null;
};
type Profile = {
    publicId: string; name: string; aliases: string[]; notes: string | null; status: string;
    bankAccounts: Array<{ publicId: string; bankName: string; accountName: string; maskedAccountNumber: string; status: string }>;
    assignments: Assignment[];
};
type ManagedLoan = {
    publicId: string; borrowerName: string; principalAmount: string; outstandingPrincipal: string;
    outstandingInterest: string; outstandingFees: string; repaymentType: string; nextDueDate: string | null;
    status: string | null; roles: string[];
};
type Group = { publicId: string; retainedBalance: string; status: string };
type HeldBalance = {
    intermediaryPublicId: string; fundingReceived: string; borrowerPayout: string;
    advanceInterestReturned: string; disbursementHeldBalance: string;
    collectionHeldBalance: string; totalHeldBalance: string;
};

export default function IntermediaryDetail() {
    const { id = "" } = useParams();
    const { t, i18n } = useTranslation();
    const [profile, setProfile] = useState<Profile | null>(null);
    const [loans, setLoans] = useState<ManagedLoan[]>([]);
    const [groups, setGroups] = useState<Group[]>([]);
    const [heldBalance, setHeldBalance] = useState<HeldBalance | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<"notFound" | "failed" | null>(null);
    const [reload, setReload] = useState(0);
    const activeProfileId = useRef(id);

    useEffect(() => {
        activeProfileId.current = id;
        let active = true;
        void Promise.all([
            api.get<Profile>(`/intermediaries/${id}`),
            api.get<ManagedLoan[]>(`/intermediaries/${id}/managed-loans`),
            api.get<HeldBalance>(`/intermediaries/${id}/held-balance`),
            api.get<Group[]>("/intermediated-disbursements", { params: { intermediaryPublicId: id } }),
        ]).then(([profileResponse, loansResponse, heldResponse, groupsResponse]) => {
            if (!active) return;
            setProfile(profileResponse.data);
            setLoans(loansResponse.data);
            setHeldBalance(heldResponse.data);
            setGroups(groupsResponse.data);
            setLoadError(null);
        }).catch((error: unknown) => {
            if (!active) return;
            const status = (error as { response?: { status?: number } })?.response?.status;
            setProfile(null); setLoans([]); setHeldBalance(null); setGroups([]);
            setLoadError(status === 404 ? "notFound" : "failed");
        }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [id, reload]);

    const totals = useMemo(() => ({
        principal: sumMoney(loans.map((loan) => loan.outstandingPrincipal)),
        interest: sumMoney(loans.map((loan) => loan.outstandingInterest)),
        fees: sumMoney(loans.map((loan) => loan.outstandingFees)),
    }), [loans]);
    const reviewGroups = groups.filter((group) => ["draft", "needs_review"].includes(group.status));
    const money = (value: string) => formatMoneyExact(value, i18n.language);
    const date = (value: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeZone: "Asia/Bangkok" }).format(new Date(value));

    if (loading) return <p>{t("common.loading")}</p>;
    if (loadError === "notFound") return <p>{t("intermediary.profile.notFound")}</p>;
    if (loadError === "failed") return <div role="alert" className="rounded-md border border-destructive/40 p-4 text-destructive"><p>{t("intermediary.profile.loadError")}</p><button className="mt-3 rounded-md border px-3 py-2 text-sm" onClick={() => { setLoading(true); setReload((value) => value + 1); }}>{t("common.retry")}</button></div>;
    if (!profile || !heldBalance) return null;

    return <div className="space-y-6">
        <Link className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground" to="/intermediaries"><ArrowLeft className="mr-2 h-4 w-4" />{t("intermediary.profile.back")}</Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h1 className="text-2xl font-bold">{profile.name}</h1><p className="text-sm text-muted-foreground">{profile.aliases.join(" · ") || profile.notes}</p></div>
            <Link className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted" to={`/intermediaries/remittances?intermediaryPublicId=${profile.publicId}`}>{t("intermediary.profile.remittances")}</Link>
        </div>

        {reviewGroups.length > 0 && <div role="alert" className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:bg-amber-950 dark:text-amber-100"><AlertTriangle className="h-5 w-5 shrink-0" /><span>{t("intermediary.profile.unreconciled", { count: reviewGroups.length })}</span></div>}

        <section aria-label={t("intermediary.profile.overview")} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {(["principal", "interest", "fees"] as const).map((key) => <div className="rounded-lg border bg-card p-4" key={key}><p className="text-sm text-muted-foreground">{t(`intermediary.profile.totals.${key}`)}</p><p className="mt-1 text-xl font-semibold">{money(totals[key])}</p></div>)}
            {(["fundingReceived", "borrowerPayout", "advanceInterestReturned", "disbursementHeldBalance", "collectionHeldBalance", "totalHeldBalance"] as const).map((key) => <div className="rounded-lg border bg-card p-4" key={key}><p className="text-sm text-muted-foreground">{t(`intermediary.profile.totals.${key}`)}</p><p className="mt-1 text-xl font-semibold">{money(heldBalance[key])}</p></div>)}
        </section>

        <section className="space-y-3"><h2 className="text-lg font-semibold">{t("intermediary.profile.managedLoans")}</h2>
            <div className="divide-y rounded-lg border bg-card md:hidden">{loans.map((loan) => <Link className="block p-4" key={loan.publicId} to={`/loans/${loan.publicId}`}><p className="font-semibold">{loan.borrowerName}</p><p className="text-sm text-muted-foreground">{money(loan.outstandingPrincipal)} · {loan.roles.map((role) => t(`intermediary.profile.roles.${role}`)).join(", ")}</p></Link>)}</div>
            <div className="hidden overflow-x-auto rounded-lg border md:block"><table className="w-full text-left text-sm"><thead className="bg-muted/50"><tr><th className="p-3">{t("intermediary.profile.borrower")}</th><th className="p-3">{t("intermediary.profile.totals.principal")}</th><th className="p-3">{t("intermediary.profile.role")}</th><th className="p-3">{t("intermediary.profile.nextDue")}</th></tr></thead><tbody>{loans.map((loan) => <tr className="border-t" key={loan.publicId}><td className="p-3"><Link className="font-medium underline-offset-4 hover:underline" to={`/loans/${loan.publicId}`}>{loan.borrowerName}</Link></td><td className="p-3">{money(loan.outstandingPrincipal)}</td><td className="p-3">{loan.roles.map((role) => t(`intermediary.profile.roles.${role}`)).join(", ")}</td><td className="p-3">{loan.nextDueDate ?? t("intermediary.profile.noDueDate")}</td></tr>)}</tbody></table></div>
        </section>

        <section className="space-y-3"><h2 className="text-lg font-semibold">{t("intermediary.profile.assignmentHistory")}</h2><div className="divide-y rounded-lg border bg-card">{profile.assignments.map((assignment) => <div className="grid gap-1 p-4 md:grid-cols-[1fr_auto_auto] md:items-center" key={assignment.publicId}><div><p className="font-medium">{assignment.borrowerName ?? assignment.loanPublicId}</p><p className="text-sm text-muted-foreground">{t(`intermediary.profile.roles.${assignment.role}`)}</p></div><p className="text-sm text-muted-foreground">{date(assignment.effectiveFrom)} – {assignment.effectiveTo ? date(assignment.effectiveTo) : t("intermediary.profile.current")}</p><span className="text-sm font-medium">{t(`intermediary.profile.status.${assignment.status}`)}</span></div>)}</div></section>

        <section className="space-y-3"><h2 className="text-lg font-semibold">{t("intermediary.profile.bankAccounts")}</h2><div className="divide-y rounded-lg border bg-card">{profile.bankAccounts.map((account) => <div className="flex items-center gap-3 p-4" key={account.publicId}><Landmark className="h-5 w-5 text-muted-foreground" /><div><p className="font-medium">{account.bankName} · {account.maskedAccountNumber}</p><p className="text-sm text-muted-foreground">{account.accountName}</p></div></div>)}</div></section>

        <IntermediaryTransferLedger intermediaryPublicId={profile.publicId} onPosted={async () => {
            await refreshForScope(profile.publicId, activeProfileId, async () => (await api.get<HeldBalance>(`/intermediaries/${profile.publicId}/held-balance`)).data, setHeldBalance);
        }} />
    </div>;
}
