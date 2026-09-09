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

function newItem(): BatchItemDraft { return { id: crypto.randomUUID(), paymentIntakePublicId: "", amount: "", targetDueDate: "", intent: "on_time", loanPublicId: "", schedulePublicId: "" }; }

export function PaymentBatchEditor({ onPreview, onExecute }: PaymentBatchEditorProps) {
    const { t } = useTranslation();
    const [borrowerPublicId, setBorrowerPublicId] = useState("");
    const [items, setItems] = useState<BatchItemDraft[]>([newItem()]);
    const [batchPublicId, setBatchPublicId] = useState<string | null>(null);
    const [batchItemPublicIds, setBatchItemPublicIds] = useState<string[]>([]);
    const [preview, setPreview] = useState<BatchPreview | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const total = useMemo(() => batchTotal(items), [items]);
    const update = (id: string, patch: Partial<BatchItemDraft>) => { setPreview(null); setConfirmed(false); setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item)); };
    const addItem = () => { setPreview(null); setConfirmed(false); setItems((current) => [...current, newItem()]); };

    const previewBatch = async () => {
        setBusy(true); setMessage(""); setConfirmed(false);
        try {
            const batch = batchPublicId ? { publicId: batchPublicId } : (await api.post("/payment-batches", { idempotencyKey: crypto.randomUUID(), borrowerPublicId: borrowerPublicId.trim() })).data;
            const itemIds = batchItemPublicIds.length ? batchItemPublicIds : [];
            if (!batchPublicId) {
                const createdIds: string[] = [];
                for (const [index, item] of items.entries()) {
                    const response = await api.post(`/payment-batches/${batch.publicId}/items`, { paymentIntakePublicId: item.paymentIntakePublicId.trim(), itemOrder: index + 1 });
                    const created = response.data.items?.find((candidate: { itemOrder: number }) => candidate.itemOrder === index + 1);
                    if (!created) throw new Error("BATCH_ITEM_RESPONSE_INVALID");
                    createdIds.push(created.publicId);
                }
                setBatchPublicId(batch.publicId); setBatchItemPublicIds(createdIds);
                const response = await api.post(`/payment-batches/${batch.publicId}/preview`, { borrowerPublicId: borrowerPublicId.trim(), allocations: toExplicitBatchAllocations(items, createdIds) });
                setPreview(response.data); onPreview?.(response.data, semanticSummary(items)); return;
            }
            const response = await api.post(`/payment-batches/${batchPublicId}/preview`, { borrowerPublicId: borrowerPublicId.trim(), allocations: toExplicitBatchAllocations(items, itemIds) });
            setPreview(response.data); onPreview?.(response.data, semanticSummary(items));
        } catch (error) { setMessage((error as { response?: { data?: { code?: string } } }).response?.data?.code ?? (error as Error).message); }
        finally { setBusy(false); }
    };

    const executeBatch = async () => {
        if (!batchPublicId || !preview || !isBatchReady(items, borrowerPublicId, confirmed, preview)) return;
        setBusy(true); setMessage("");
        try {
            const result = await api.post(`/payment-batches/${batchPublicId}/execute`, { previewPublicId: preview.publicId, previewHash: preview.previewHash, confirmationHash: preview.confirmationHash, confirmed: true, idempotencyKey: crypto.randomUUID() });
            onExecute?.(result.data); setMessage(t("paymentBatch.posted"));
        } catch (error) { setMessage((error as { response?: { data?: { code?: string } } }).response?.data?.code ?? (error as Error).message); }
        finally { setBusy(false); }
    };

    const ready = isBatchReady(items, borrowerPublicId, confirmed, preview);
    return <Card data-testid="payment-batch-editor"><CardHeader><CardTitle>{t("paymentBatch.title")}</CardTitle></CardHeader><CardContent className="space-y-4">
        <label className="grid gap-1 text-sm">{t("paymentBatch.borrower")}<Input value={borrowerPublicId} onChange={(event) => setBorrowerPublicId(event.target.value)} placeholder={t("paymentBatch.borrowerPlaceholder")} /></label>
        {items.map((item, index) => <div className="grid gap-2 rounded border p-3 md:grid-cols-3" key={item.id} data-testid="payment-batch-row">
            <Input aria-label={t("paymentBatch.intake", { index: index + 1 })} value={item.paymentIntakePublicId} onChange={(event) => update(item.id, { paymentIntakePublicId: event.target.value })} placeholder={t("paymentBatch.intakePlaceholder")} />
            <Input aria-label={t("paymentBatch.amount")} inputMode="decimal" value={item.amount} onChange={(event) => update(item.id, { amount: event.target.value })} placeholder="0.00" />
            <Input aria-label={t("paymentBatch.dueDate")} type="date" value={item.targetDueDate} onChange={(event) => update(item.id, { targetDueDate: event.target.value })} />
            <Input aria-label={t("paymentBatch.loan")} value={item.loanPublicId} onChange={(event) => update(item.id, { loanPublicId: event.target.value })} placeholder={t("paymentBatch.loanPlaceholder")} />
            <Input aria-label={t("paymentBatch.schedule")} value={item.schedulePublicId} onChange={(event) => update(item.id, { schedulePublicId: event.target.value })} placeholder={t("paymentBatch.schedulePlaceholder")} />
            <select aria-label={t("paymentBatch.intent")} value={item.intent} onChange={(event) => update(item.id, { intent: event.target.value as BatchItemDraft["intent"] })}><option value="on_time">{t("paymentBatch.onTime")}</option><option value="advance">{t("paymentBatch.advance")}</option><option value="backdated">{t("paymentBatch.backdated")}</option></select>
        </div>)}
        <Button type="button" variant="outline" onClick={addItem}>{t("paymentBatch.addItem")}</Button>
        <p>{t("paymentBatch.total", { amount: normalizeMoney(total) })}</p>
        {preview && <div className="rounded border p-3 text-sm" data-testid="payment-batch-preview"><p>{t("paymentBatch.previewStatus", { status: preview.status, version: preview.version })}</p><p>{t("paymentBatch.allocationCount", { count: preview.allocations.length })}</p>{preview.warnings.map((warning) => <p className="text-amber-700" key={warning.code}>{t("paymentBatch.warning", { code: warning.code })}</p>)}</div>}
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> {t("paymentBatch.confirm")}</label>
        {message && <p role="status">{message}</p>}
        <div className="flex gap-2"><Button type="button" disabled={busy || !borrowerPublicId.trim() || items.some((item) => !item.paymentIntakePublicId.trim())} onClick={() => void previewBatch()}>{t("paymentBatch.preview")}</Button><Button type="button" disabled={busy || !ready} onClick={() => void executeBatch()}>{t("paymentBatch.execute")}</Button></div>
    </CardContent></Card>;
}
