import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { api } from "../../../lib/api";
import { batchTotal, isBatchReady, normalizeMoney, semanticSummary, toExplicitBatchAllocations, type BatchItemDraft, type BatchPreview } from "./payment-batch-model";

export interface PaymentBatchEditorProps {
    onPreview?: (preview: BatchPreview, rows: BatchItemDraft[]) => void;
    onExecute?: (result: unknown) => void;
}

function newItem(): BatchItemDraft { return { id: crypto.randomUUID(), paymentIntakePublicId: "", amount: "", targetDueDate: "", receivedAt: "", intent: "on_time", loanPublicId: "", schedulePublicId: "" }; }
function errorMessage(error: unknown) { return (error as { response?: { data?: { code?: string } } }).response?.data?.code ?? (error as Error).message; }
async function sha256(file: File) { const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); }

export function PaymentBatchEditor({ onPreview, onExecute }: PaymentBatchEditorProps) {
    const { t } = useTranslation();
    const [borrowerPublicId, setBorrowerPublicId] = useState("");
    const [items, setItems] = useState<BatchItemDraft[]>([newItem()]);
    const [stageIdempotencyKey] = useState(() => crypto.randomUUID());
    const [batchPublicId, setBatchPublicId] = useState<string | null>(null);
    const [batchItemPublicIds, setBatchItemPublicIds] = useState<string[]>([]);
    const [preview, setPreview] = useState<BatchPreview | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const total = useMemo(() => batchTotal(items), [items]);
    const reviewed = items.every((item) => Boolean(item.stagingItemPublicId && item.paymentIntakePublicId && item.file));
    const update = (id: string, patch: Partial<BatchItemDraft>) => { setPreview(null); setConfirmed(false); setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item)); };
    const addItem = () => { if (batchPublicId) return; setPreview(null); setConfirmed(false); setItems((current) => [...current, newItem()]); };

    const stageAndReview = async (): Promise<{ batchPublicId: string; batchItemPublicIds: string[]; items: BatchItemDraft[] } | null> => {
        if (items.some((item) => !item.file || !item.amount || !item.receivedAt)) return null;
        const staged = batchPublicId
            ? { batchPublicId, items: items.filter((item) => item.stagingItemPublicId).map((item) => ({ publicId: item.stagingItemPublicId!, clientItemKey: item.id })) }
            : (await api.post("/payment-batches/stage", { idempotencyKey: stageIdempotencyKey, borrowerPublicId: borrowerPublicId.trim() || null, items: items.map((item) => ({ clientItemKey: item.id })) })).data as { batchPublicId: string; items: Array<{ publicId: string; clientItemKey: string }> };
        const next = [...items];
        const batchItems: string[] = items.flatMap((item) => item.batchItemPublicId ?? []);
        if (!batchPublicId) setBatchPublicId(staged.batchPublicId);
        for (const stagedItem of staged.items) {
            const index = next.findIndex((item) => item.id === stagedItem.clientItemKey);
            if (index >= 0) next[index] = { ...next[index], stagingItemPublicId: stagedItem.publicId };
        }
        setItems(next);
        for (const stagedItem of staged.items) {
            const index = next.findIndex((item) => item.id === stagedItem.clientItemKey);
            const item = next[index];
            if (!item?.file || item.paymentIntakePublicId) continue;
            const file = item.file;
            const prepared = (await api.post(`/payment-batches/staging/${stagedItem.publicId}/evidence/prepare`, { mimeType: file.type, size: file.size, sha256: await sha256(file), originalName: file.name })).data as { evidencePublicId: string; status?: string; uploadUrl?: string; requiredHeaders?: Record<string, string> };
            if (prepared.status !== "ready" && prepared.uploadUrl) {
                const uploaded = await fetch(prepared.uploadUrl, { method: "PUT", headers: prepared.requiredHeaders, body: file });
                if (!uploaded.ok) throw new Error("PAYMENT_BATCH_UPLOAD_FAILED");
                await api.post(`/payment-batches/staging/${stagedItem.publicId}/evidence/finalize`, { evidencePublicId: prepared.evidencePublicId });
            }
            const review = (await api.post(`/payment-batches/staging/${stagedItem.publicId}/review`, { amount: normalizeMoney(item.amount), receivedAt: new Date(item.receivedAt!).toISOString(), intakeIdempotencyKey: `batch-intake:${item.id}` })).data as { paymentIntakePublicId: string; batchItemPublicId: string };
            next[index] = { ...item, stagingItemPublicId: stagedItem.publicId, paymentIntakePublicId: review.paymentIntakePublicId, batchItemPublicId: review.batchItemPublicId };
            batchItems.push(review.batchItemPublicId);
        }
        setBatchPublicId(staged.batchPublicId); setBatchItemPublicIds(batchItems); setItems(next);
        return { batchPublicId: staged.batchPublicId, batchItemPublicIds: batchItems, items: next };
    };

    const previewBatch = async () => {
        setBusy(true); setMessage(""); setConfirmed(false);
        try {
            const staged = batchPublicId ? null : await stageAndReview();
            const activeBatchId = batchPublicId ?? staged?.batchPublicId;
            if (!activeBatchId) { setMessage(t("paymentBatch.reviewBeforePreview")); return; }
            const previewRows = staged?.items ?? items;
            const ids = batchItemPublicIds.length ? batchItemPublicIds : staged?.batchItemPublicIds ?? previewRows.map((item) => item.batchItemPublicId ?? "");
            const response = await api.post(`/payment-batches/${activeBatchId}/preview`, { borrowerPublicId: borrowerPublicId.trim(), allocations: toExplicitBatchAllocations(previewRows, ids) });
            setPreview(response.data); onPreview?.(response.data, semanticSummary(previewRows));
        } catch (error) { setMessage(errorMessage(error)); }
        finally { setBusy(false); }
    };

    const executeBatch = async () => {
        if (!batchPublicId || !preview || !isBatchReady(items, borrowerPublicId, confirmed, preview)) return;
        setBusy(true); setMessage("");
        try { const result = await api.post(`/payment-batches/${batchPublicId}/execute`, { previewPublicId: preview.publicId, previewHash: preview.previewHash, confirmationHash: preview.confirmationHash, confirmed: true, idempotencyKey: crypto.randomUUID() }); onExecute?.(result.data); setMessage(t("paymentBatch.posted")); }
        catch (error) { setMessage(errorMessage(error)); }
        finally { setBusy(false); }
    };

    const ready = isBatchReady(items, borrowerPublicId, confirmed, preview);
    return <Card data-testid="payment-batch-editor"><CardHeader><CardTitle>{t("paymentBatch.title")}</CardTitle><div className="grid grid-cols-2 gap-1 text-xs md:grid-cols-4" aria-label={t("paymentBatch.steps")}><span className="rounded bg-slate-900 px-2 py-1 text-white">1. {t("paymentBatch.stepCapture")}</span><span className="rounded border px-2 py-1">2. {t("paymentBatch.stepReview")}</span><span className="rounded border px-2 py-1">3. {t("paymentBatch.stepChronology")}</span><span className="rounded border px-2 py-1">4. {t("paymentBatch.stepConfirm")}</span></div></CardHeader><CardContent className="space-y-4">
        <label className="grid gap-1 text-sm">{t("paymentBatch.borrower")}<Input value={borrowerPublicId} disabled={Boolean(batchPublicId)} onChange={(event) => setBorrowerPublicId(event.target.value)} placeholder={t("paymentBatch.borrowerPlaceholder")} /></label>
        {items.map((item, index) => <div className="grid gap-2 rounded border p-3 md:grid-cols-3" key={item.id} data-testid="payment-batch-row">
            <label className="grid gap-1 text-sm md:col-span-3">{t("paymentBatch.upload", { index: index + 1 })}<Input type="file" accept="image/jpeg,image/png,application/pdf" disabled={Boolean(batchPublicId)} onChange={(event) => update(item.id, { file: event.target.files?.[0] })} />{item.file && <span className="text-xs text-muted-foreground">{item.file.name}</span>}</label>
            <Input aria-label={t("paymentBatch.amount")} disabled={Boolean(batchPublicId)} inputMode="decimal" value={item.amount} onChange={(event) => update(item.id, { amount: event.target.value })} placeholder="0.00" />
            <Input aria-label={t("paymentBatch.receivedAt")} disabled={Boolean(batchPublicId)} type="datetime-local" value={item.receivedAt} onChange={(event) => update(item.id, { receivedAt: event.target.value })} />
            <Input aria-label={t("paymentBatch.dueDate")} disabled={Boolean(batchPublicId)} type="date" value={item.targetDueDate} onChange={(event) => update(item.id, { targetDueDate: event.target.value })} />
            <Input aria-label={t("paymentBatch.loan")} disabled={Boolean(batchPublicId)} value={item.loanPublicId} onChange={(event) => update(item.id, { loanPublicId: event.target.value })} placeholder={t("paymentBatch.loanPlaceholder")} />
            <Input aria-label={t("paymentBatch.schedule")} disabled={Boolean(batchPublicId)} value={item.schedulePublicId} onChange={(event) => update(item.id, { schedulePublicId: event.target.value })} placeholder={t("paymentBatch.schedulePlaceholder")} />
            <select aria-label={t("paymentBatch.intent")} disabled={Boolean(batchPublicId)} value={item.intent} onChange={(event) => update(item.id, { intent: event.target.value as BatchItemDraft["intent"] })}><option value="on_time">{t("paymentBatch.onTime")}</option><option value="advance">{t("paymentBatch.advance")}</option><option value="backdated">{t("paymentBatch.backdated")}</option></select>
        </div>)}
        <Button type="button" variant="outline" disabled={Boolean(batchPublicId)} onClick={addItem}>{t("paymentBatch.addItem")}</Button>
        <p>{t("paymentBatch.total", { amount: normalizeMoney(total) })}</p>
        {reviewed && <p className="text-sm text-emerald-700">{t("paymentBatch.reviewed")}</p>}
        {preview && <div className="rounded border p-3 text-sm" data-testid="payment-batch-preview"><p>{t("paymentBatch.previewStatus", { status: preview.status, version: preview.version })}</p><p>{t("paymentBatch.allocationCount", { count: preview.allocations.length })}</p>{preview.warnings.map((warning) => <p className="text-amber-700" key={warning.code}>{t("paymentBatch.warning", { code: warning.code })}</p>)}</div>}
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> {t("paymentBatch.confirm")}</label>
        {message && <p role="status">{message}</p>}
        <div className="flex gap-2"><Button type="button" disabled={busy || !borrowerPublicId.trim() || items.some((item) => !item.file || !item.amount || !item.receivedAt || !item.targetDueDate || !item.loanPublicId)} onClick={() => void previewBatch()}>{t("paymentBatch.preview")}</Button><Button type="button" disabled={busy || !ready} onClick={() => void executeBatch()}>{t("paymentBatch.execute")}</Button></div>
    </CardContent></Card>;
}
