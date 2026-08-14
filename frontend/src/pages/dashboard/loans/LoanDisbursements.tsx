import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FileUp, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, resolveFileAccess } from "../../../lib/api";
import { formatDisbursementSummary, type DisbursementSummaryInput } from "../../../lib/disbursement-view";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { normalizeMoney } from "../../../lib/workflow-api";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { EvidencePreviewButton } from "../../../components/evidence/EvidencePreviewButton";

type Channel = "bank_transfer" | "cash" | "adjustment";
type Disbursement = { publicId: string; status: "draft" | "posted" | "reversed"; grossAmount: string; loanAttributedAmount: string; channel: Channel; sourceBankProfilePublicId?: string | null; payeeHint?: string | null; note?: string | null; disbursedAt?: string; evidenceFilePublicIds: string[]; reversedEventPublicId?: string | null };
type Ledger = { loanPublicId: string; summary: DisbursementSummaryInput; events: Disbursement[] };
type Draft = { grossAmount: string; loanAttributedAmount: string; channel: Channel; sourceBankProfilePublicId: string; payeeHint: string; disbursedAt: string; note: string };
type EvidenceIntent = { publicId: string; status?: string; uploadUrl?: string; requiredHeaders?: Record<string, string>; duplicate?: boolean };

const blankDraft = (): Draft => ({ grossAmount: "", loanAttributedAmount: "", channel: "bank_transfer", sourceBankProfilePublicId: "", payeeHint: "", disbursedAt: new Date().toISOString().slice(0, 16), note: "" });
const validMoney = (value: string) => /^\d+(?:\.\d{1,2})?$/.test(value) && /[1-9]/.test(value);
const hash = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
class SupersededLedgerReadError extends Error { constructor() { super("Disbursement ledger read was superseded"); } }
type ActiveLedgerRead = { controller: AbortController; supersede: () => void };

export type LoanDisbursementsHandle = { refresh: () => Promise<void> };

export const LoanDisbursements = forwardRef<LoanDisbursementsHandle, { loanPublicId: string }>(function LoanDisbursements({ loanPublicId }, ref) {
    const { t, i18n } = useTranslation();
    const [ledgerState, setLedger] = useState<Ledger | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [selected, setSelected] = useState<Disbursement | null>(null);
    const [reversalOpen, setReversalOpen] = useState(false);
    const [reason, setReason] = useState("");
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const readGeneration = useRef(0);
    const activeRead = useRef<ActiveLedgerRead | null>(null);
    const operationKeys = useRef(new Map<string, string>());
    const actionKey = (action: string, eventId: string) => {
        const key = `${action}:${eventId}`;
        const existing = operationKeys.current.get(key);
        if (existing) return existing;
        const created = crypto.randomUUID();
        operationKeys.current.set(key, created);
        return created;
    };
    const readLedger = async () => {
        activeRead.current?.supersede();
        const generation = ++readGeneration.current;
        const scope = loanPublicId;
        const controller = new AbortController();
        let rejectSuperseded!: (error: SupersededLedgerReadError) => void;
        const superseded = new Promise<never>((_resolve, reject) => { rejectSuperseded = reject; });
        const current: ActiveLedgerRead = {
            controller,
            supersede: () => {
                controller.abort();
                rejectSuperseded(new SupersededLedgerReadError());
            },
        };
        activeRead.current = current;
        try {
            const response = await Promise.race([
                api.get(`/loans/${loanPublicId}/disbursements`, { signal: controller.signal }),
                superseded,
            ]);
            const next = response.data as Ledger;
            if (generation !== readGeneration.current || activeRead.current !== current || next.loanPublicId !== scope) throw new SupersededLedgerReadError();
            setLedger(next);
            setMessage("");
            setSelected((selectedEvent) => selectedEvent ? next.events.find((event) => event.publicId === selectedEvent.publicId) ?? null : null);
        } catch (error) {
            if (generation !== readGeneration.current || activeRead.current !== current) throw new SupersededLedgerReadError();
            throw error;
        } finally {
            if (activeRead.current === current) activeRead.current = null;
        }
    };
    useImperativeHandle(ref, () => ({ refresh: readLedger }));
    useEffect(() => {
        void readLedger().catch((error) => { if (!(error instanceof SupersededLedgerReadError)) setMessage(t("loanDetail.disbursements.errors.load")); });
        return () => { readGeneration.current += 1; activeRead.current?.supersede(); activeRead.current = null; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loanPublicId, t]);

    const saveDraft = async () => {
        if (!draft) return;
        setBusy(true); setMessage("");
        try {
            const body = { ...draft, grossAmount: normalizeMoney(draft.grossAmount), loanAttributedAmount: normalizeMoney(draft.loanAttributedAmount), sourceBankProfilePublicId: draft.sourceBankProfilePublicId || null, payeeHint: draft.payeeHint || null, note: draft.note || null, disbursedAt: new Date(draft.disbursedAt).toISOString() };
            const response = selected?.status === "draft" ? await api.put(`/loans/${loanPublicId}/disbursements/${selected.publicId}`, body) : await api.post(`/loans/${loanPublicId}/disbursements`, body);
            const event = response.data as Disbursement;
            setSelected(event); setDraft({ ...draft, grossAmount: event.grossAmount, loanAttributedAmount: event.loanAttributedAmount });
            await readLedger();
        } catch { setMessage(t("loanDetail.disbursements.errors.save")); } finally { setBusy(false); }
    };
    const post = async () => {
        if (!selected) return;
        setBusy(true); setMessage("");
        try { await api.post(`/loans/${loanPublicId}/disbursements/${selected.publicId}/post`, {}, { headers: { "Idempotency-Key": actionKey("post", selected.publicId) } }); setDraft(null); await readLedger(); }
        catch { setMessage(t("loanDetail.disbursements.errors.post")); } finally { setBusy(false); }
    };
    const reverse = async () => {
        if (!selected || !reason.trim()) return;
        setBusy(true); setMessage("");
        try { await api.post(`/loans/${loanPublicId}/disbursements/${selected.publicId}/reverse`, { reason: reason.trim() }, { headers: { "Idempotency-Key": actionKey("reverse", selected.publicId) } }); setSelected(null); setDraft(null); setReversalOpen(false); setReason(""); await readLedger(); }
        catch { setMessage(t("loanDetail.disbursements.errors.reverse")); } finally { setBusy(false); }
    };
    const uploadEvidence = async (file: File) => {
        if (!selected || selected.status !== "draft") return;
        setBusy(true); setMessage("");
        try {
            const sha256 = hash(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
            const intent = (await api.post(`/loans/${loanPublicId}/disbursements/${selected.publicId}/evidence/upload-intents`, { mimeType: file.type, size: file.size, sha256, originalName: file.name })).data as EvidenceIntent;
            if (!intent.duplicate && intent.uploadUrl) { const result = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.requiredHeaders, body: file }); if (!result.ok) throw new Error("upload failed"); }
            if (!intent.duplicate) await api.post(`/loans/${loanPublicId}/disbursements/${selected.publicId}/evidence/${intent.publicId}/finalize`);
            await readLedger();
        } catch { setMessage(t("loanDetail.disbursements.errors.evidence")); } finally { setBusy(false); }
    };
    const differs = Boolean(draft && validMoney(draft.grossAmount) && validMoney(draft.loanAttributedAmount) && normalizeMoney(draft.grossAmount) !== normalizeMoney(draft.loanAttributedAmount));
    const canSave = Boolean(draft && validMoney(draft.grossAmount) && validMoney(draft.loanAttributedAmount) && (!differs || draft.note.trim()));
    const ledger = ledgerState?.loanPublicId === loanPublicId ? ledgerState : null;
    const summary = ledger ? formatDisbursementSummary(ledger.summary) : null;
    return <Card><CardHeader className="flex-row items-center justify-between gap-3 space-y-0"><div><CardTitle>{t("loanDetail.disbursements.title")}</CardTitle><p className="mt-1 text-sm text-muted-foreground">{t("loanDetail.disbursements.description")}</p></div><Button size="sm" disabled={busy} onClick={() => { setSelected(null); setDraft(blankDraft()); }}>{t("loanDetail.disbursements.add")}</Button></CardHeader><CardContent className="space-y-4">
        {message && <div role="alert" className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{message}</div>}
        <div className="grid gap-3 rounded border p-3 text-sm sm:grid-cols-3"><div><div className="text-muted-foreground">{t("loanDetail.disbursements.approved")}</div><div className="font-medium">{formatMoneyExact(summary?.approvedPrincipal ?? "0.00", i18n.language)}</div></div><div><div className="text-muted-foreground">{t("loanDetail.disbursements.net")}</div><div className="font-medium">{formatMoneyExact(summary?.netDisbursed ?? "0.00", i18n.language)}</div></div><div><div className="text-muted-foreground">{t("loanDetail.disbursements.variance")}</div><div className="font-medium">{formatMoneyExact(summary?.variance ?? "0.00", i18n.language)} · {t(`loanDetail.disbursements.status.${summary?.status ?? "under_disbursed"}`)}</div></div></div>
        {draft && <div className="grid gap-3 rounded border border-dashed p-3 md:grid-cols-2"><label className="grid gap-1 text-sm">{t("loanDetail.disbursements.gross")}<Input value={draft.grossAmount} inputMode="decimal" onChange={(event) => setDraft({ ...draft, grossAmount: event.target.value })} /></label><label className="grid gap-1 text-sm">{t("loanDetail.disbursements.attributed")}<Input value={draft.loanAttributedAmount} inputMode="decimal" onChange={(event) => setDraft({ ...draft, loanAttributedAmount: event.target.value })} /></label><label className="grid gap-1 text-sm">{t("loanDetail.disbursements.channel")}<select className="h-10 rounded border bg-background px-3" value={draft.channel} onChange={(event) => setDraft({ ...draft, channel: event.target.value as Channel })}><option value="bank_transfer">{t("loanDetail.disbursements.channels.bank_transfer")}</option><option value="cash">{t("loanDetail.disbursements.channels.cash")}</option><option value="adjustment">{t("loanDetail.disbursements.channels.adjustment")}</option></select></label><label className="grid gap-1 text-sm">{t("loanDetail.disbursements.disbursedAt")}<Input type="datetime-local" value={draft.disbursedAt} onChange={(event) => setDraft({ ...draft, disbursedAt: event.target.value })} /></label><label className="grid gap-1 text-sm">{t("loanDetail.disbursements.sourceProfile")}<Input value={draft.sourceBankProfilePublicId} placeholder={t("loanDetail.disbursements.optional")} onChange={(event) => setDraft({ ...draft, sourceBankProfilePublicId: event.target.value })} /></label><label className="grid gap-1 text-sm">{t("loanDetail.disbursements.payeeHint")}<Input value={draft.payeeHint} onChange={(event) => setDraft({ ...draft, payeeHint: event.target.value })} /></label>{differs && <label className="grid gap-1 text-sm md:col-span-2">{t("loanDetail.disbursements.groupExplanation")}<Input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>}<div className="flex flex-wrap gap-2 md:col-span-2"><Button disabled={busy || !canSave} onClick={() => void saveDraft()}>{t("loanDetail.disbursements.saveDraft")}</Button>{selected?.status === "draft" && <label className="inline-flex cursor-pointer items-center rounded border px-3 py-2 text-sm"><FileUp className="mr-2 h-4 w-4" />{t("loanDetail.disbursements.addEvidence")}<input className="hidden" type="file" accept="image/jpeg,image/png,application/pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadEvidence(file); }} /></label>}</div></div>}
        {selected?.status === "draft" && <Button disabled={busy} onClick={() => void post()}>{t("loanDetail.disbursements.post")}</Button>}
        {selected?.status === "posted" && <div className="rounded border p-3">{!reversalOpen && <Button variant="destructive" disabled={busy} onClick={() => setReversalOpen(true)}><RotateCcw className="mr-2 h-4 w-4" />{t("loanDetail.disbursements.reverse")}</Button>}{reversalOpen && <div className="mt-3 grid gap-2"><label className="grid gap-1 text-sm">{t("loanDetail.disbursements.reversalReason")}<Input value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className="flex gap-2"><Button variant="outline" onClick={() => setReversalOpen(false)}>{t("common.cancel")}</Button><Button variant="destructive" disabled={busy || !reason.trim()} onClick={() => void reverse()}>{t("loanDetail.disbursements.confirmReverse")}</Button></div></div>}</div>}
        {ledger?.events.length ? <div className="space-y-2">{ledger.events.map((event) => <div key={event.publicId} className="rounded border p-3 text-sm"><button type="button" className="w-full text-left" onClick={() => { setSelected(event); setDraft(event.status === "draft" ? { grossAmount: event.grossAmount, loanAttributedAmount: event.loanAttributedAmount, channel: event.channel, sourceBankProfilePublicId: event.sourceBankProfilePublicId ?? "", payeeHint: event.payeeHint ?? "", note: event.note ?? "", disbursedAt: event.disbursedAt?.slice(0, 16) ?? "" } : null); }}><span className="font-medium">{t(`loanDetail.disbursements.channels.${event.channel}`)} · {t(`loanDetail.disbursements.recordStatus.${event.status}`)}</span><span className="float-right">{formatMoneyExact(event.loanAttributedAmount, i18n.language)}</span></button><div className="mt-1 text-xs text-muted-foreground">{event.sourceBankProfilePublicId && <span>{event.sourceBankProfilePublicId} · </span>}{event.payeeHint && <span>{event.payeeHint}</span>}</div>{event.status !== "draft" && normalizeMoney(event.grossAmount) !== normalizeMoney(event.loanAttributedAmount) && <div className="mt-1 text-xs text-muted-foreground">{t("loanDetail.disbursements.grouped", { gross: formatMoneyExact(event.grossAmount, i18n.language), attributed: formatMoneyExact(event.loanAttributedAmount, i18n.language) })}</div>}<div className="mt-2 flex flex-wrap gap-2">{event.evidenceFilePublicIds.map((id, index) => <EvidencePreviewButton key={id} available label={`${t("evidence.preview")} ${index + 1}`} resolve={() => resolveFileAccess(id)} />)}</div></div>)}</div> : <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">{t("loanDetail.disbursements.empty")}</div>}
    </CardContent></Card>;
});
