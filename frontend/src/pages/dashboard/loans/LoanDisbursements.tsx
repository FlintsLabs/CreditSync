import { useEffect, useState } from "react";
import { FileUp, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";

type Disbursement = {
    publicId: string; status: "draft" | "posted" | "reversed";
    grossAmount: string; loanAttributedAmount: string; channel: "bank_transfer" | "cash" | "adjustment";
    disbursedAt?: string; note?: string | null; evidence?: Array<{ publicId: string; mimeType: string; status: string }>;
};
type Summary = { approvedPrincipal: string; netDisbursed: string; variance: string; status: string; items: Disbursement[] };
type EvidenceIntent = { publicId: string; status?: string; uploadUrl?: string; requiredHeaders?: Record<string, string>; duplicate?: boolean };

const emptyDraft = () => ({ grossAmount: "", loanAttributedAmount: "", channel: "bank_transfer" as "bank_transfer" | "cash" | "adjustment", disbursedAt: new Date().toISOString().slice(0, 16), note: "" });
const validMoney = (value: string) => /^\d+(?:\.\d{1,2})?$/.test(value) && Number(value) > 0;
const hash = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export function LoanDisbursements({ loanPublicId, formatCurrency }: { loanPublicId: string; formatCurrency: (value: number) => string }) {
    const { t } = useTranslation();
    const [summary, setSummary] = useState<Summary | null>(null);
    const [draft, setDraft] = useState<ReturnType<typeof emptyDraft> | null>(null);
    const [selected, setSelected] = useState<Disbursement | null>(null);
    const [reversalOpen, setReversalOpen] = useState(false);
    const [reason, setReason] = useState("");
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);

    const refresh = async () => {
        const response = await api.get(`/loans/${loanPublicId}/disbursements`);
        const next = response.data as Summary;
        setSummary(next);
        if (selected) setSelected(next.items.find((item) => item.publicId === selected.publicId) ?? selected);
    };
    useEffect(() => {
        let current = true;
        const load = async () => {
            try {
                const response = await api.get(`/loans/${loanPublicId}/disbursements`);
                if (current) setSummary(response.data as Summary);
            } catch {
                if (current) setMessage(t("loanDetail.disbursements.errors.load"));
            }
        };
        void load();
        return () => { current = false; };
    }, [loanPublicId, t]);

    const saveDraft = async () => {
        if (!draft) return;
        setBusy(true); setMessage("");
        try {
            const body = { ...draft, grossAmount: Number(draft.grossAmount).toFixed(2), loanAttributedAmount: Number(draft.loanAttributedAmount).toFixed(2), disbursedAt: new Date(draft.disbursedAt).toISOString() };
            const response = selected?.status === "draft"
                ? await api.put(`/loans/${loanPublicId}/disbursements/${selected.publicId}`, body)
                : await api.post(`/loans/${loanPublicId}/disbursements`, body);
            const next = response.data as Disbursement;
            setSelected(next); setDraft({ ...draft, grossAmount: next.grossAmount, loanAttributedAmount: next.loanAttributedAmount });
            setSummary((current) => current ? { ...current, items: [...current.items.filter((item) => item.publicId !== next.publicId), next] } : current);
        } catch { setMessage(t("loanDetail.disbursements.errors.save")); } finally { setBusy(false); }
    };
    const post = async () => {
        if (!selected) return;
        setBusy(true); setMessage("");
        try {
            const response = await api.post(`/loans/${loanPublicId}/disbursements/${selected.publicId}/post`, {});
            const next = response.data as Disbursement;
            setSelected(next); setDraft(null);
            setSummary((current) => current ? { ...current, items: current.items.map((item) => item.publicId === next.publicId ? { ...item, ...next } : item) } : current);
        } catch { setMessage(t("loanDetail.disbursements.errors.post")); } finally { setBusy(false); }
    };
    const reverse = async () => {
        if (!selected || !reason.trim()) return;
        setBusy(true); setMessage("");
        try {
            const response = await api.post(`/loans/${loanPublicId}/disbursements/${selected.publicId}/reverse`, { reason: reason.trim() });
            const next = response.data as Disbursement;
            setSelected(next); setReversalOpen(false); setReason("");
            setSummary((current) => current ? { ...current, items: current.items.map((item) => item.publicId === next.publicId ? { ...item, ...next } : item) } : current);
        } catch { setMessage(t("loanDetail.disbursements.errors.reverse")); } finally { setBusy(false); }
    };
    const uploadEvidence = async (file: File) => {
        if (!selected || selected.status !== "draft") return;
        setBusy(true); setMessage("");
        try {
            const sha256 = hash(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
            const intent = (await api.post(`/loans/${loanPublicId}/disbursements/${selected.publicId}/evidence/upload-intents`, { mimeType: file.type, size: file.size, sha256 })).data as EvidenceIntent;
            if (!intent.duplicate && intent.uploadUrl) {
                const upload = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.requiredHeaders, body: file });
                if (!upload.ok) throw new Error("upload failed");
            }
            if (!intent.duplicate) await api.post(`/loans/${loanPublicId}/disbursements/${selected.publicId}/evidence/${intent.publicId}/finalize`);
            await refresh();
        } catch { setMessage(t("loanDetail.disbursements.errors.evidence")); } finally { setBusy(false); }
    };

    const differs = Boolean(draft && draft.grossAmount && draft.loanAttributedAmount && Number(draft.grossAmount) !== Number(draft.loanAttributedAmount));
    const canSave = Boolean(draft && validMoney(draft.grossAmount) && validMoney(draft.loanAttributedAmount) && (!differs || draft.note.trim()));
    return <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0"><div><CardTitle>{t("loanDetail.disbursements.title")}</CardTitle><p className="mt-1 text-sm text-muted-foreground">{t("loanDetail.disbursements.description")}</p></div><Button size="sm" disabled={busy} onClick={() => { setSelected(null); setDraft(emptyDraft()); }}>{t("loanDetail.disbursements.add")}</Button></CardHeader>
        <CardContent className="space-y-4">
            {message && <div role="alert" className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{message}</div>}
            <div className="grid gap-3 rounded border p-3 text-sm sm:grid-cols-3"><div><div className="text-muted-foreground">{t("loanDetail.disbursements.approved")}</div><div className="font-medium">{formatCurrency(Number(summary?.approvedPrincipal ?? 0))}</div></div><div><div className="text-muted-foreground">{t("loanDetail.disbursements.net")}</div><div className="font-medium">{formatCurrency(Number(summary?.netDisbursed ?? 0))}</div></div><div><div className="text-muted-foreground">{t("loanDetail.disbursements.variance")}</div><div className="font-medium">{formatCurrency(Number(summary?.variance ?? 0))} · {t(`loanDetail.disbursements.status.${summary?.status ?? "under_disbursed"}`)}</div></div></div>
            {draft && <div className="grid gap-3 rounded border border-dashed p-3 md:grid-cols-2"><label className="grid gap-1 text-sm">{t("loanDetail.disbursements.gross")}<Input value={draft.grossAmount} inputMode="decimal" onChange={(event) => setDraft({ ...draft, grossAmount: event.target.value })} /></label><label className="grid gap-1 text-sm">{t("loanDetail.disbursements.attributed")}<Input value={draft.loanAttributedAmount} inputMode="decimal" onChange={(event) => setDraft({ ...draft, loanAttributedAmount: event.target.value })} /></label><label className="grid gap-1 text-sm">{t("loanDetail.disbursements.channel")}<select className="h-10 rounded border bg-background px-3" value={draft.channel} onChange={(event) => setDraft({ ...draft, channel: event.target.value as typeof draft.channel })}><option value="bank_transfer">{t("loanDetail.disbursements.channels.bank_transfer")}</option><option value="cash">{t("loanDetail.disbursements.channels.cash")}</option><option value="adjustment">{t("loanDetail.disbursements.channels.adjustment")}</option></select></label><label className="grid gap-1 text-sm">{t("loanDetail.disbursements.disbursedAt")}<Input type="datetime-local" value={draft.disbursedAt} onChange={(event) => setDraft({ ...draft, disbursedAt: event.target.value })} /></label>{differs && <label className="grid gap-1 text-sm md:col-span-2">{t("loanDetail.disbursements.groupExplanation")}<Input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>}<div className="flex flex-wrap gap-2 md:col-span-2"><Button disabled={busy || !canSave} onClick={() => void saveDraft()}>{t("loanDetail.disbursements.saveDraft")}</Button>{selected?.status === "draft" && <label className="inline-flex cursor-pointer items-center rounded border px-3 py-2 text-sm"><FileUp className="mr-2 h-4 w-4" />{t("loanDetail.disbursements.addEvidence")}<input className="hidden" type="file" accept="image/jpeg,image/png,application/pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadEvidence(file); }} /></label>}</div></div>}
            {selected?.status === "draft" && <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void post()}>{t("loanDetail.disbursements.post")}</Button></div>}
            {selected?.status === "posted" && <div className="rounded border p-3"><div className="flex flex-wrap gap-2">{!reversalOpen && <Button variant="destructive" disabled={busy} onClick={() => setReversalOpen(true)}><RotateCcw className="mr-2 h-4 w-4" />{t("loanDetail.disbursements.reverse")}</Button>}</div>{reversalOpen && <div className="mt-3 grid gap-2"><label className="grid gap-1 text-sm">{t("loanDetail.disbursements.reversalReason")}<Input value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className="flex gap-2"><Button variant="outline" onClick={() => setReversalOpen(false)}>{t("common.cancel")}</Button><Button variant="destructive" disabled={busy || !reason.trim()} onClick={() => void reverse()}>{t("loanDetail.disbursements.confirmReverse")}</Button></div></div>}</div>}
            {summary?.items?.length ? <div className="space-y-2">{summary.items.map((item) => <button type="button" key={item.publicId} onClick={() => { setSelected(item); setDraft(item.status === "draft" ? { grossAmount: item.grossAmount, loanAttributedAmount: item.loanAttributedAmount, channel: item.channel, disbursedAt: item.disbursedAt?.slice(0, 16) ?? "", note: item.note ?? "" } : null); }} className="w-full rounded border p-3 text-left text-sm hover:bg-muted/30"><div className="flex justify-between gap-3"><span className="font-medium">{t(`loanDetail.disbursements.channels.${item.channel}`)} · {t(`loanDetail.disbursements.recordStatus.${item.status}`)}</span><span>{formatCurrency(Number(item.loanAttributedAmount))}</span></div>{item.grossAmount !== item.loanAttributedAmount && <div className="mt-1 text-xs text-muted-foreground">{t("loanDetail.disbursements.grouped", { gross: formatCurrency(Number(item.grossAmount)), attributed: formatCurrency(Number(item.loanAttributedAmount)) })}</div>}</button>)}</div> : <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">{t("loanDetail.disbursements.empty")}</div>}
        </CardContent>
    </Card>;
}
