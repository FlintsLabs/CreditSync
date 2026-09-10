import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { api } from "../../../lib/api";
import { batchTotal, isBatchReady, normalizeMoney, semanticSummary, toExplicitBatchAllocations, type BatchCandidateResult, type BatchItemDraft, type BatchPreview } from "./payment-batch-model";

export interface PaymentBatchEditorProps {
    onPreview?: (preview: BatchPreview, rows: BatchItemDraft[]) => void;
    onExecute?: (result: unknown) => void;
}

type StagedResponse = { batchPublicId: string; items: Array<{ publicId: string; clientItemKey: string }> };
type ReviewResponse = { paymentIntakePublicId: string; batchItemPublicId: string };
type WorkspaceResponse = { batch: { publicId: string; version: number; borrowerId?: string | null }; items?: Array<{ publicId?: string; stagingItemPublicId?: string; paymentIntakePublicId?: string; batchItemPublicId?: string; amount?: string; receivedAt?: string; targetDueDate?: string; intent?: BatchItemDraft["intent"]; payerName?: string }> };

function newItem(): BatchItemDraft { return { id: crypto.randomUUID(), paymentIntakePublicId: "", amount: "", targetDueDate: "", receivedAt: "", intent: "on_time", loanPublicId: "", schedulePublicId: "" }; }
function safeError(error: unknown) { return (error as { response?: { data?: { code?: string } } }).response?.data?.code ?? "PAYMENT_BATCH_REQUEST_FAILED"; }
async function sha256(file: File) { const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function businessDate(value: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }

export function PaymentBatchEditor({ onPreview, onExecute }: PaymentBatchEditorProps) {
    const { t } = useTranslation();
    const [items, setItems] = useState<BatchItemDraft[]>([newItem()]);
    const [batchPublicId, setBatchPublicId] = useState<string | null>(null);
    const [batchRevision, setBatchRevision] = useState(0);
    const [preview, setPreview] = useState<BatchPreview | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [step, setStep] = useState(1);
    const [decisionReason, setDecisionReason] = useState("");
    const [decisionAcknowledged, setDecisionAcknowledged] = useState(false);
    const [selectedForSplit, setSelectedForSplit] = useState<string[]>([]);
    const [executeKey] = useState(() => crypto.randomUUID());
    const candidateRequest = useRef(new Map<string, number>());
    const total = useMemo(() => batchTotal(items), [items]);
    const selectedBorrowers = [...new Set(items.flatMap((item) => item.allocations?.length ? [item.selectedBorrowerPublicId ?? ""] : []))].filter(Boolean);
    const borrowerPublicId = selectedBorrowers[0] ?? "";
    const reviewed = items.length > 0 && items.every((item) => Boolean(item.stagingItemPublicId && item.paymentIntakePublicId));
    const ready = isBatchReady(items, borrowerPublicId, confirmed, preview);

    useEffect(() => {
        const saved = localStorage.getItem("creditsync.paymentBatch.workspace");
        if (!saved) return;
        void api.get(`/payment-batches/${saved}/workspace`).then(({ data }: { data: WorkspaceResponse }) => {
            setBatchPublicId(data.batch.publicId); setBatchRevision(data.batch.version);
            if (data.items?.length) setItems(data.items.map((row) => ({ ...newItem(), id: row.publicId ?? crypto.randomUUID(), stagingItemPublicId: row.stagingItemPublicId ?? row.publicId, paymentIntakePublicId: row.paymentIntakePublicId ?? "", batchItemPublicId: row.batchItemPublicId, amount: row.amount ?? "", receivedAt: row.receivedAt ?? "", targetDueDate: row.targetDueDate ?? "", intent: row.intent ?? "on_time", payerName: row.payerName })));
            setStep(2);
        }).catch(() => undefined);
    }, []);

    const update = (id: string, patch: Partial<BatchItemDraft>) => { setPreview(null); setConfirmed(false); setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item)); };
    const addFiles = (files: FileList | File[]) => {
        const accepted = [...files].slice(0, Math.max(0, 50 - items.length));
        if (!accepted.length) return;
        setItems((current) => current.map((item, index) => index === 0 && !item.file ? { ...item, file: accepted[0] } : item).concat((items[0]?.file ? accepted : accepted.slice(1)).map((file) => ({ ...newItem(), file }))));
    };
    const uploadChange = (event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; };

    const loadCandidates = async (item: BatchItemDraft, activeBatchId = batchPublicId) => {
        if (!activeBatchId || !item.stagingItemPublicId || !item.receivedAt) return;
        const requestNumber = (candidateRequest.current.get(item.id) ?? 0) + 1; candidateRequest.current.set(item.id, requestNumber);
        try {
            const { data } = await api.get(`/payment-batches/staging/${item.stagingItemPublicId}/candidates`, { params: { q: item.payerName ?? "", amount: normalizeMoney(item.amount), receivedAt: new Date(item.receivedAt).toISOString() } });
            if (candidateRequest.current.get(item.id) !== requestNumber) return;
            update(item.id, { candidates: data as BatchCandidateResult });
        } catch (error) { update(item.id, { error: safeError(error) }); }
    };

    const stageAndReview = async () => {
        if (items.some((item) => !item.file && !item.paymentIntakePublicId || !item.amount || !item.receivedAt || !item.targetDueDate)) { setMessage(t("paymentBatch.incomplete")); return; }
        setBusy(true); setMessage("");
        try {
            const staged = batchPublicId ? { batchPublicId, items: items.filter((item) => item.stagingItemPublicId).map((item) => ({ publicId: item.stagingItemPublicId!, clientItemKey: item.id })) } : (await api.post("/payment-batches/stage", { idempotencyKey: crypto.randomUUID(), borrowerPublicId: null, items: items.map((item) => ({ clientItemKey: item.id, payerName: item.payerName ?? null, bankReference: item.bankReference ?? null })) })).data as StagedResponse;
            setBatchPublicId(staged.batchPublicId); localStorage.setItem("creditsync.paymentBatch.workspace", staged.batchPublicId);
            const next = [...items];
            for (const stagedItem of staged.items) {
                const index = next.findIndex((item) => item.id === stagedItem.clientItemKey); const item = next[index];
                if (!item) continue;
                if (item.file && !item.paymentIntakePublicId) {
                    const file = item.file; const prepared = (await api.post(`/payment-batches/staging/${stagedItem.publicId}/evidence/prepare`, { mimeType: file.type, size: file.size, sha256: await sha256(file), originalName: file.name })).data as { evidencePublicId: string; status?: string; uploadUrl?: string; requiredHeaders?: Record<string, string> };
                    if (prepared.status !== "ready" && prepared.uploadUrl) { const uploaded = await fetch(prepared.uploadUrl, { method: "PUT", headers: prepared.requiredHeaders, body: file }); if (!uploaded.ok) throw new Error("PAYMENT_BATCH_UPLOAD_FAILED"); await api.post(`/payment-batches/staging/${stagedItem.publicId}/evidence/finalize`, { evidencePublicId: prepared.evidencePublicId }); }
                    const review = (await api.post(`/payment-batches/staging/${stagedItem.publicId}/review`, { amount: normalizeMoney(item.amount), receivedAt: new Date(item.receivedAt!).toISOString(), intakeIdempotencyKey: `batch-intake:${item.id}`, reviewedReason: "Human review in batch workspace" })).data as ReviewResponse;
                    next[index] = { ...item, stagingItemPublicId: stagedItem.publicId, paymentIntakePublicId: review.paymentIntakePublicId, batchItemPublicId: review.batchItemPublicId };
                } else next[index] = { ...item, stagingItemPublicId: stagedItem.publicId };
            }
            setItems(next); setBatchRevision((value) => value + 1); setStep(2);
            for (const item of next) await loadCandidates(item, staged.batchPublicId);
        } catch (error) { setMessage(safeError(error)); }
        finally { setBusy(false); }
    };

    const selectBorrower = (item: BatchItemDraft, publicId: string) => { const candidate = item.candidates?.contractCandidates.find((contract) => contract.borrowerPublicId === publicId); update(item.id, { selectedBorrowerPublicId: publicId, loanPublicId: candidate?.loanPublicId ?? "", schedulePublicId: "", allocations: candidate ? [{ loanPublicId: candidate.loanPublicId, amount: item.amount }] : [] }); };
    const selectLoan = (item: BatchItemDraft, index: number, loanPublicId: string) => { const allocations = [...(item.allocations ?? [{ loanPublicId, amount: item.amount }])]; allocations[index] = { ...allocations[index], loanPublicId, schedulePublicId: undefined }; update(item.id, { loanPublicId, allocations }); };
    const previewBatch = async () => {
        if (!batchPublicId || !reviewed || !borrowerPublicId) { setMessage(t("paymentBatch.reviewBeforePreview")); return; }
        setBusy(true); setMessage(""); setConfirmed(false);
        try { const ids = items.map((item) => item.batchItemPublicId ?? ""); const response = (await api.post(`/payment-batches/${batchPublicId}/preview`, { borrowerPublicId, allocations: toExplicitBatchAllocations(items, ids) })).data as BatchPreview; setPreview(response); setBatchRevision(response.version); setStep(3); onPreview?.(response, semanticSummary(items)); }
        catch (error) { setMessage(safeError(error)); } finally { setBusy(false); }
    };
    const decideAndRefresh = async () => {
        if (!batchPublicId || !preview || !decisionReason.trim()) return;
        setBusy(true); setMessage("");
        try { await api.post(`/payment-batches/${batchPublicId}/decision`, { previewPublicId: preview.publicId, previewHash: preview.previewHash, revision: preview.version, action: "confirm_no_older_pending", reason: decisionReason, fromDate: businessDate(items.map((item) => item.receivedAt ?? "").sort()[0]), toDate: businessDate(items.map((item) => item.receivedAt ?? "").sort().at(-1) ?? "") , idempotencyKey: crypto.randomUUID() }); setDecisionAcknowledged(true); await previewBatch(); }
        catch (error) { setMessage(safeError(error)); } finally { setBusy(false); }
    };
    const executeBatch = async () => { if (!batchPublicId || !preview || !ready) return; setBusy(true); setMessage(""); try { const result = await api.post(`/payment-batches/${batchPublicId}/execute`, { previewPublicId: preview.publicId, previewHash: preview.previewHash, confirmationHash: preview.confirmationHash, confirmed: true, idempotencyKey: executeKey }); onExecute?.(result.data); setMessage(t("paymentBatch.posted")); setStep(4); } catch (error) { setMessage(safeError(error)); } finally { setBusy(false); } };
    const mutateBatch = async (action: "split" | "cancel") => { if (!batchPublicId) return; if (action === "split" && selectedForSplit.length === 0) { setMessage(t("paymentBatch.reviewBeforePreview")); return; } const reason = window.prompt(t("paymentBatch.reasonPrompt")); if (!reason) return; setBusy(true); try { const body = action === "split" ? { selectedItemPublicIds: selectedForSplit, expectedSourceRevision: batchRevision, idempotencyKey: crypto.randomUUID(), reason } : { reason, revision: batchRevision, idempotencyKey: crypto.randomUUID() }; await api.post(`/payment-batches/${batchPublicId}/${action}`, body); setPreview(null); setConfirmed(false); setSelectedForSplit([]); setMessage(t("paymentBatch.mutationComplete")); } catch (error) { setMessage(safeError(error)); } finally { setBusy(false); } };

    return <Card data-testid="payment-batch-editor"><CardHeader><CardTitle>{t("paymentBatch.title")}</CardTitle><div className="grid grid-cols-2 gap-1 text-xs md:grid-cols-4" aria-label={t("paymentBatch.steps")}>{["stepCapture", "stepReview", "stepChronology", "stepConfirm"].map((label, index) => <span key={label} className={`rounded px-2 py-1 ${step === index + 1 ? "bg-slate-900 text-white" : "border"}`}>{index + 1}. {t(`paymentBatch.${label}`)}</span>)}</div></CardHeader><CardContent className="space-y-4">
        <div className="rounded border border-dashed p-4" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}><p>{t("paymentBatch.dropzone")}</p><Input aria-label={t("paymentBatch.chooseFiles")} type="file" multiple accept="image/jpeg,image/png,application/pdf" disabled={Boolean(batchPublicId)} onChange={uploadChange} /></div>
        {items.map((item) => <div className="grid gap-2 rounded border p-3 md:grid-cols-4" key={item.id} data-testid="payment-batch-row">
            <label className="grid gap-1 text-sm md:col-span-2">{t("paymentBatch.payerName")}<Input value={item.payerName ?? ""} disabled={Boolean(item.paymentIntakePublicId)} onChange={(event) => update(item.id, { payerName: event.target.value })} /></label>
            <label className="grid gap-1 text-sm">{t("paymentBatch.amount")}<Input inputMode="decimal" value={item.amount} disabled={Boolean(item.paymentIntakePublicId)} onChange={(event) => update(item.id, { amount: event.target.value })} placeholder="0.00" /></label>
            <label className="grid gap-1 text-sm">{t("paymentBatch.receivedAt")}<Input type="datetime-local" value={item.receivedAt} disabled={Boolean(item.paymentIntakePublicId)} onChange={(event) => update(item.id, { receivedAt: event.target.value })} /></label>
            <label className="grid gap-1 text-sm">{t("paymentBatch.dueDate")}<Input type="date" value={item.targetDueDate} disabled={Boolean(item.paymentIntakePublicId)} onChange={(event) => update(item.id, { targetDueDate: event.target.value })} /></label>
            <span className="text-xs md:col-span-2">{item.file?.name ?? (item.paymentIntakePublicId ? t("paymentBatch.resumed") : t("paymentBatch.noFile"))}</span>{batchPublicId && item.batchItemPublicId && <label className="text-xs"><input type="checkbox" checked={selectedForSplit.includes(item.batchItemPublicId)} onChange={(event) => setSelectedForSplit((current) => event.target.checked ? [...current, item.batchItemPublicId!] : current.filter((id) => id !== item.batchItemPublicId))} /> {t("paymentBatch.split")}</label>}
            {item.candidates && <div className="grid gap-2 md:col-span-4"><p className="text-sm">{item.candidates.reviewRequired ? t("paymentBatch.manualReview") : t("paymentBatch.candidateReady")}</p><label className="text-sm">{t("paymentBatch.selectBorrower")}<select className="ml-2 rounded border p-1" value={item.selectedBorrowerPublicId ?? ""} onChange={(event) => selectBorrower(item, event.target.value)}><option value="">{t("paymentBatch.chooseCandidate")}</option>{item.candidates.borrowerCandidates.map((candidate) => <option key={candidate.publicId} value={candidate.publicId}>{candidate.name} ({candidate.matchType ?? "candidate"})</option>)}</select></label>{(item.allocations ?? []).map((allocation, allocationIndex) => <div className="flex flex-wrap gap-2" key={`${item.id}-${allocationIndex}`}><select aria-label={t("paymentBatch.selectContract")} className="rounded border p-1" value={allocation.loanPublicId} onChange={(event) => selectLoan(item, allocationIndex, event.target.value)}><option value="">{t("paymentBatch.chooseContract")}</option>{item.candidates?.contractCandidates.filter((candidate) => candidate.borrowerPublicId === item.selectedBorrowerPublicId && candidate.eligible).map((candidate) => <option key={candidate.loanPublicId} value={candidate.loanPublicId}>{candidate.borrowerName} · {candidate.repaymentType} · {candidate.status}</option>)}</select><Input aria-label={t("paymentBatch.allocationAmount")} inputMode="decimal" value={allocation.amount} onChange={(event) => { const allocations = [...(item.allocations ?? [])]; allocations[allocationIndex] = { ...allocations[allocationIndex], amount: event.target.value }; update(item.id, { allocations }); }} /></div>)}<Button type="button" variant="outline" onClick={() => update(item.id, { allocations: [...(item.allocations ?? []), { loanPublicId: "", amount: "" }] })}>{t("paymentBatch.addContract")}</Button></div>}
            {item.error && <p role="alert" className="text-sm text-red-700">{item.error}</p>}
        </div>)}
        {!batchPublicId && <Button type="button" variant="outline" onClick={() => setItems((current) => [...current, newItem()])}>{t("paymentBatch.addItem")}</Button>}
        <p>{t("paymentBatch.total", { amount: normalizeMoney(total) })}</p><p className="text-xs text-muted-foreground">{t("paymentBatch.noFinancialWrites")}</p>
        {preview && <div className="rounded border p-3 text-sm" data-testid="payment-batch-preview"><p>{t("paymentBatch.previewStatus", { status: preview.status, version: preview.version })}</p><p>{t("paymentBatch.allocationCount", { count: preview.allocations.length })}</p>{preview.warnings.map((warning) => <p className="text-amber-700" key={warning.code}>{t("paymentBatch.warning", { code: warning.code })}</p>)}{preview.warnings.length > 0 && <div className="mt-2"><Input aria-label={t("paymentBatch.decisionReason")} value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} placeholder={t("paymentBatch.decisionReason")} /><Button type="button" disabled={busy || !decisionReason.trim()} onClick={() => void decideAndRefresh()}>{t("paymentBatch.newPreview")}</Button></div>}</div>}
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> {t("paymentBatch.confirm")}</label>{decisionAcknowledged && <p className="text-sm text-emerald-700">{t("paymentBatch.decisionRecorded")}</p>}{message && <p role="status">{message}</p>}
        <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || reviewed} onClick={() => void stageAndReview()}>{t("paymentBatch.uploadReview")}</Button><Button type="button" disabled={busy || !reviewed} onClick={() => void previewBatch()}>{t("paymentBatch.preview")}</Button><Button type="button" disabled={busy || !ready} onClick={() => void executeBatch()}>{t("paymentBatch.execute")}</Button>{batchPublicId && <><Button type="button" variant="outline" disabled={busy} onClick={() => void mutateBatch("split")}>{t("paymentBatch.split")}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void mutateBatch("cancel")}>{t("paymentBatch.cancelBatch")}</Button></>}</div>
    </CardContent></Card>;
}
