import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { api } from "../../../lib/api";
import { batchTotal, isBatchReady, normalizeBangkokDateTime, normalizeMoney, semanticSummary, toBangkokDateTimeInput, toExplicitBatchAllocations, type BatchCandidateResult, type BatchItemDraft, type BatchPreview } from "./payment-batch-model";

export interface PaymentBatchEditorProps {
    onPreview?: (preview: BatchPreview, rows: BatchItemDraft[]) => void;
    onExecute?: (result: unknown) => void;
}

type StagedResponse = { batchPublicId: string; items: Array<{ publicId: string; clientItemKey: string }> };
type WorkspaceResponse = { batchPublicId: string; batch: { publicId: string; version: number; status: string; borrowerPublicId?: string | null; latestPreview?: BatchPreview | null }; items?: Array<{ publicId: string; clientItemKey: string; revision: number; paymentIntakePublicId?: string | null; batchItemPublicId?: string | null; amount?: string | null; receivedAt?: string | null; payerName?: string | null; evidenceStatus?: string | null; intent?: BatchItemDraft["intent"] }> };
type ReceiptSummary = { auditPublicId?: string; correlationId?: string; receiptPublicId?: string };
type SplitResult = { sourceBatchPublicId: string; destinationBatchPublicId: string; dependencyPublicId: string; movedItemPublicIds: string[]; auditPublicId?: string; correlationId?: string; destinationItemPublicIds?: string[] };

function newItem(): BatchItemDraft { return { id: crypto.randomUUID(), paymentIntakePublicId: "", amount: "", targetDueDate: "", receivedAt: "", intent: "on_time", loanPublicId: "", schedulePublicId: "", uploadStatus: "pending" }; }
function safeError(error: unknown) { return (error as { response?: { data?: { code?: string } } }).response?.data?.code ?? "PAYMENT_BATCH_REQUEST_FAILED"; }
async function sha256(file: File) { const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function businessDate(value: string) { const parsed = new Date(value); if (Number.isNaN(parsed.getTime())) return ""; return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(parsed); }
function storageScope() { try { const token = localStorage.getItem("token"); const payload = token?.split(".")[1]; const normalized = payload?.replace(/-/g, "+").replace(/_/g, "/"); const padded = normalized ? normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=") : ""; const decoded = padded ? JSON.parse(atob(padded)) as { tenantId?: string; sub?: string } : {}; return `creditsync.paymentBatch.workspace:${decoded.tenantId ?? "anonymous"}:${decoded.sub ?? "anonymous"}`; } catch { return "creditsync.paymentBatch.workspace:anonymous"; } }
function operationStorageKey(kind: "capture" | "execute", batchId: string | null) { return `${storageScope()}:${kind}-key:${batchId ?? "draft"}`; }
function draftItems(): BatchItemDraft[] | null { try { const raw = localStorage.getItem(`${storageScope()}:draft`); const parsed = raw ? JSON.parse(raw) as Array<Partial<BatchItemDraft>> : null; return parsed?.length ? parsed.map((item) => ({ ...newItem(), ...item, file: undefined, bankReference: undefined })) : null; } catch { return null; } }
function componentText(components: Record<string, string> | null | undefined, t: (key: string) => string) {
    if (!components) return `${t("paymentBatchNoComponents")}`;
    return ["principal", "interest", "fee", "penalty"].map((key) => `${t(`paymentBatchComponent.${key}`)} ${components[key] ?? "0.00"}`).join(" · ");
}

export function PaymentBatchEditor({ onPreview, onExecute }: PaymentBatchEditorProps) {
    const { t } = useTranslation();
    const [items, setItems] = useState<BatchItemDraft[]>(() => draftItems() ?? [newItem()]);
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
    const [receipt, setReceipt] = useState<ReceiptSummary | null>(null);
    const [splitResult, setSplitResult] = useState<SplitResult | null>(null);
    const [captureKey, setCaptureKey] = useState(() => { const batchId = localStorage.getItem(`${storageScope()}:batch-id`); return localStorage.getItem(operationStorageKey("capture", batchId)) ?? crypto.randomUUID(); });
    const [executeKey, setExecuteKey] = useState(() => { const batchId = localStorage.getItem(`${storageScope()}:batch-id`); return localStorage.getItem(operationStorageKey("execute", batchId)) ?? crypto.randomUUID(); });
    const candidateRequest = useRef(new Map<string, number>());
    const previewRequest = useRef(0);
    const hydrationRequest = useRef(0);
    const initialSavedBatchId = useRef(localStorage.getItem(`${storageScope()}:batch-id`));
    const total = useMemo(() => batchTotal(items), [items]);
    const selectedBorrowers = [...new Set(items.flatMap((item) => item.allocations?.length ? [item.selectedBorrowerPublicId ?? ""] : []))].filter(Boolean);
    const borrowerPublicId = selectedBorrowers[0] ?? "";
    const reviewed = items.length > 0 && items.every((item) => Boolean(item.stagingItemPublicId && item.paymentIntakePublicId));
    const ready = isBatchReady(items, borrowerPublicId, confirmed, preview);
    const allocationLabel = (allocation: BatchPreview["allocations"][number]) => { const candidate = items.flatMap((item) => item.candidates?.contractCandidates ?? []).find((row) => row.loanPublicId === allocation.loanPublicId); return candidate ? `${candidate.borrowerName} · ${candidate.repaymentType} · ${candidate.status} · ${candidate.startDate ?? t("paymentBatchUnknownStart")} · ${candidate.principalAmount ?? "0.00"}` : t("paymentBatchSelectedContract"); };

    useEffect(() => { localStorage.setItem(operationStorageKey("capture", batchPublicId), captureKey); localStorage.setItem(operationStorageKey("execute", batchPublicId), executeKey); }, [batchPublicId, captureKey, executeKey]);
    useEffect(() => {
        const saved = initialSavedBatchId.current;
        if (!saved) return;
        const request = ++hydrationRequest.current;
        void api.get(`/payment-batches/${saved}/workspace`).then(({ data }: { data: WorkspaceResponse }) => { if (request !== hydrationRequest.current || localStorage.getItem(`${storageScope()}:batch-id`) !== saved) return; mergeWorkspace(data); setStep(data.batch.latestPreview ? 3 : 2); }).catch(() => undefined);
    }, []);
    useEffect(() => { localStorage.setItem(`${storageScope()}:draft`, JSON.stringify(items.map(({ id, paymentIntakePublicId, amount, targetDueDate, intent, loanPublicId, schedulePublicId, stagingItemPublicId, batchItemPublicId, selectedBorrowerPublicId, allocations, revision, evidenceStatus, uploadStatus, payerName }) => ({ id, paymentIntakePublicId, amount, targetDueDate, intent, loanPublicId, schedulePublicId, stagingItemPublicId, batchItemPublicId, selectedBorrowerPublicId, allocations, revision, evidenceStatus, uploadStatus, payerName })))); }, [items]);

    const update = (id: string, patch: Partial<BatchItemDraft>) => { hydrationRequest.current += 1; previewRequest.current += 1; setPreview(null); setConfirmed(false); setDecisionAcknowledged(false); setDecisionReason(""); candidateRequest.current.set(id, (candidateRequest.current.get(id) ?? 0) + 1); setItems((current) => current.map((item) => { if (item.id !== id) return item; const reviewedFieldChanged = Boolean(item.paymentIntakePublicId && ("amount" in patch || "receivedAt" in patch || "targetDueDate" in patch || "payerName" in patch || "bankReference" in patch || "allocations" in patch)); return { ...item, ...patch, ...(reviewedFieldChanged ? { reviewedEditPending: true } : {}) }; })); };
    const addFiles = (files: FileList | File[]) => {
        const accepted = [...files].slice(0, Math.max(0, 50 - items.length));
        if (!accepted.length) return;
        setItems((current) => { const remaining = [...accepted]; const attached = current.map((item) => !item.file && remaining.length ? { ...item, file: remaining.shift(), uploadStatus: "pending" as const, error: undefined } : item); return batchPublicId ? attached : attached.concat(remaining.map((file) => ({ ...newItem(), file }))); });
    };
    const uploadChange = (event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; };

    const loadCandidates = async (item: BatchItemDraft, activeBatchId = batchPublicId) => {
        if (!activeBatchId || !item.stagingItemPublicId || !item.receivedAt) return;
        const requestNumber = (candidateRequest.current.get(item.id) ?? 0) + 1; candidateRequest.current.set(item.id, requestNumber);
        try {
            const receivedAt = normalizeBangkokDateTime(item.receivedAt);
            if (!receivedAt) return;
            const { data } = await api.get(`/payment-batches/staging/${item.stagingItemPublicId}/candidates`, { params: { q: item.payerName ?? "", amount: normalizeMoney(item.amount), receivedAt } });
            if (candidateRequest.current.get(item.id) !== requestNumber) return;
            update(item.id, { candidates: data as BatchCandidateResult });
        } catch (error) { update(item.id, { error: safeError(error) }); }
    };

    const mergeWorkspace = (data: WorkspaceResponse) => {
        setBatchPublicId(data.batchPublicId); setBatchRevision(data.batch.version); setPreview(data.batch.latestPreview ?? null);
        if (!data.items?.length) { setItems([]); return; }
        setItems((current) => data.items!.map((row) => { const old = current.find((item) => item.id === row.clientItemKey); return { ...newItem(), ...(old ? { file: old.file, candidates: old.candidates, selectedBorrowerPublicId: old.selectedBorrowerPublicId, allocations: old.allocations, loanPublicId: old.loanPublicId, schedulePublicId: old.schedulePublicId, payerName: old.payerName, bankReference: old.bankReference, amount: old.amount, targetDueDate: old.targetDueDate, receivedAt: old.receivedAt, intent: old.intent, error: old.error } : {}), id: row.clientItemKey, stagingItemPublicId: row.publicId, paymentIntakePublicId: row.paymentIntakePublicId ?? "", batchItemPublicId: row.batchItemPublicId ?? undefined, amount: row.amount ?? old?.amount ?? "", receivedAt: row.receivedAt ? toBangkokDateTimeInput(row.receivedAt) : old?.receivedAt ?? "", intent: row.intent ?? old?.intent ?? "on_time", payerName: row.payerName ?? undefined, revision: row.revision, evidenceStatus: row.evidenceStatus, reviewedEditPending: false, uploadStatus: row.evidenceStatus === "ready" ? "ready" : old?.uploadStatus === "failed" ? "failed" : "pending" }; }));
    };
    const refreshWorkspace = async (activeBatchId: string) => { const { data } = await api.get(`/payment-batches/${activeBatchId}/workspace`) as { data: WorkspaceResponse }; mergeWorkspace(data); return data; };

    const captureFiles = async () => {
        if (items.some((item) => !item.file && !item.stagingItemPublicId)) { setMessage(t("paymentBatch.incomplete")); return; }
        hydrationRequest.current += 1; setBusy(true); setMessage("");
        try {
            const staged = batchPublicId ? { batchPublicId, items: items.filter((item) => item.stagingItemPublicId).map((item) => ({ publicId: item.stagingItemPublicId!, clientItemKey: item.id })) } : (await api.post("/payment-batches/stage", { idempotencyKey: captureKey, borrowerPublicId: null, items: items.map((item) => ({ clientItemKey: item.id, payerName: item.payerName ?? null, bankReference: item.bankReference ?? null })) })).data as StagedResponse;
            const batchCaptureKey = localStorage.getItem(operationStorageKey("capture", staged.batchPublicId)) ?? captureKey; const batchExecuteKey = localStorage.getItem(operationStorageKey("execute", staged.batchPublicId)) ?? crypto.randomUUID(); setCaptureKey(batchCaptureKey); setExecuteKey(batchExecuteKey); localStorage.setItem(operationStorageKey("capture", staged.batchPublicId), batchCaptureKey); localStorage.setItem(operationStorageKey("execute", staged.batchPublicId), batchExecuteKey); setBatchPublicId(staged.batchPublicId); localStorage.setItem(`${storageScope()}:batch-id`, staged.batchPublicId); setStep(2);
            for (const stagedItem of staged.items) {
                const item = items.find((candidate) => candidate.id === stagedItem.clientItemKey); if (!item) continue;
                setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, stagingItemPublicId: stagedItem.publicId, uploadStatus: "uploading", error: undefined } : candidate));
                if (!item.file) { if (item.evidenceStatus === "ready") setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, stagingItemPublicId: stagedItem.publicId, uploadStatus: "ready" } : candidate)); continue; }
                try {
                    const file = item.file; const prepared = (await api.post(`/payment-batches/staging/${stagedItem.publicId}/evidence/prepare`, { mimeType: file.type, size: file.size, sha256: await sha256(file), originalName: file.name })).data as { evidencePublicId: string; status?: string; uploadUrl?: string; requiredHeaders?: Record<string, string> };
                    if (prepared.status !== "ready") { if (!prepared.uploadUrl) throw new Error("PAYMENT_BATCH_EVIDENCE_UPLOAD_URL_MISSING"); const uploaded = await fetch(prepared.uploadUrl, { method: "PUT", headers: prepared.requiredHeaders, body: file }); if (!uploaded.ok) throw new Error("PAYMENT_BATCH_UPLOAD_FAILED"); await api.post(`/payment-batches/staging/${stagedItem.publicId}/evidence/finalize`, { evidencePublicId: prepared.evidencePublicId }); }
                    setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, stagingItemPublicId: stagedItem.publicId, uploadStatus: "ready", evidenceStatus: "ready" } : candidate));
                } catch (error) { setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, stagingItemPublicId: stagedItem.publicId, uploadStatus: "failed", error: safeError(error) } : candidate)); }
            }
            await refreshWorkspace(staged.batchPublicId);
        } catch (error) { setMessage(safeError(error)); } finally { setBusy(false); }
    };

    const reviewItems = async () => {
        if (items.some((item) => !item.stagingItemPublicId || !item.amount || !normalizeBangkokDateTime(item.receivedAt ?? "") || !item.targetDueDate || item.uploadStatus === "failed")) { setMessage(t("paymentBatch.incomplete")); return; }
        setBusy(true); setMessage("");
        try {
            for (const item of items.filter((candidate) => !candidate.paymentIntakePublicId)) {
                const receivedAt = normalizeBangkokDateTime(item.receivedAt!); if (!receivedAt) throw new Error("INVALID_RECEIVED_AT");
                await api.post(`/payment-batches/staging/${item.stagingItemPublicId}/review`, { amount: normalizeMoney(item.amount), receivedAt, intakeIdempotencyKey: `batch-intake:${item.id}`, reviewedReason: "Human review in batch workspace" });
            }
            const data = await refreshWorkspace(batchPublicId!); setStep(2);
            for (const item of items) { const current = data.items?.find((row) => row.clientItemKey === item.id); if (current) await loadCandidates({ ...item, stagingItemPublicId: current.publicId, paymentIntakePublicId: current.paymentIntakePublicId ?? "" }, batchPublicId!); }
        } catch (error) { setMessage(safeError(error)); } finally { setBusy(false); }
    };

    const selectBorrower = (item: BatchItemDraft, publicId: string) => { update(item.id, { selectedBorrowerPublicId: publicId, loanPublicId: "", schedulePublicId: "", allocations: [] }); };
    const selectLoan = (item: BatchItemDraft, index: number, loanPublicId: string) => { const allocations = [...(item.allocations ?? [{ loanPublicId: "", amount: "" }])]; allocations[index] = { ...allocations[index], loanPublicId, schedulePublicId: undefined }; update(item.id, { loanPublicId, schedulePublicId: "", allocations }); };
    const selectSchedule = (item: BatchItemDraft, index: number, schedulePublicId: string) => { const allocations = [...(item.allocations ?? [])]; allocations[index] = { ...allocations[index], schedulePublicId: schedulePublicId || undefined }; update(item.id, { schedulePublicId, allocations }); };
    const previewBatch = async (decisionPublicId?: string) => {
        if (!batchPublicId || !reviewed || !borrowerPublicId || items.some((item) => item.reviewedEditPending)) { setMessage(t("paymentBatch.reviewBeforePreview")); return; }
        const requestNumber = ++previewRequest.current;
        setBusy(true); setMessage(""); setConfirmed(false);
        try { const ids = items.map((item) => item.batchItemPublicId ?? ""); const response = (await api.post(`/payment-batches/${batchPublicId}/preview`, { borrowerPublicId, decisionPublicId, allocations: toExplicitBatchAllocations(items, ids) })).data as BatchPreview; if (previewRequest.current !== requestNumber) return; setPreview(response); setBatchRevision(response.version); setDecisionAcknowledged(Boolean(decisionPublicId)); setStep(3); onPreview?.(response, semanticSummary(items)); }
        catch (error) { setMessage(safeError(error)); } finally { setBusy(false); }
    };
    const decideAndRefresh = async () => {
        if (!batchPublicId || !preview || !decisionReason.trim()) return;
        setBusy(true); setMessage("");
        try { const current = await refreshWorkspace(batchPublicId); const decision = (await api.post(`/payment-batches/${batchPublicId}/decision`, { previewPublicId: preview.publicId, previewHash: preview.previewHash, revision: current.batch.version, action: "confirm_no_older_pending", reason: decisionReason, fromDate: businessDate(items.map((item) => item.receivedAt ?? "").sort()[0]), toDate: businessDate(items.map((item) => item.receivedAt ?? "").sort().at(-1) ?? "") , idempotencyKey: crypto.randomUUID() })).data as { decisionPublicId: string }; await previewBatch(decision.decisionPublicId); }
        catch (error) { setMessage(safeError(error)); } finally { setBusy(false); }
    };
    const executeBatch = async () => { if (!batchPublicId || !preview || !ready) return; setBusy(true); setMessage(""); try { const result = await api.post(`/payment-batches/${batchPublicId}/execute`, { previewPublicId: preview.publicId, previewHash: preview.previewHash, confirmationHash: preview.confirmationHash, confirmed: true, idempotencyKey: executeKey }); const data = result.data as { receipt?: ReceiptSummary; auditPublicId?: string; correlationId?: string }; setReceipt(data.receipt ?? { auditPublicId: data.auditPublicId, correlationId: data.correlationId }); onExecute?.(result.data); setMessage(t("paymentBatch.posted")); setStep(4); } catch (error) { setMessage(safeError(error)); } finally { setBusy(false); } };
    const editReviewedItem = async (item: BatchItemDraft) => { if (!batchPublicId || !item.stagingItemPublicId || !item.revision) return; const reason = window.prompt(t("paymentBatch.reasonPrompt")); if (!reason) return; const receivedAt = normalizeBangkokDateTime(item.receivedAt ?? ""); if (!receivedAt) { setMessage(t("paymentBatch.incomplete")); return; } setBusy(true); try { await api.post(`/payment-batches/staging/${item.stagingItemPublicId}/edit`, { expectedRevision: item.revision, idempotencyKey: `batch-edit:${item.stagingItemPublicId}:${item.revision}`, reason, amount: normalizeMoney(item.amount), receivedAt }); await refreshWorkspace(batchPublicId); setMessage(t("paymentBatch.mutationComplete")); } catch (error) { setMessage(safeError(error)); } finally { setBusy(false); } };
    const mutateBatch = async (action: "split" | "cancel") => { if (!batchPublicId) return; if (action === "split" && selectedForSplit.length === 0) { setMessage(t("paymentBatch.reviewBeforePreview")); return; } const reason = window.prompt(t("paymentBatch.reasonPrompt")); if (!reason) return; hydrationRequest.current += 1; setBusy(true); try { const sourceId = batchPublicId; const current = await refreshWorkspace(sourceId); const body = action === "split" ? { selectedItemPublicIds: selectedForSplit, expectedSourceRevision: current.batch.version, idempotencyKey: crypto.randomUUID(), reason } : { reason, revision: current.batch.version, idempotencyKey: crypto.randomUUID() }; const response = (await api.post(`/payment-batches/${sourceId}/${action}`, body)).data as SplitResult & { status?: string; view?: unknown }; setPreview(null); setConfirmed(false); setSelectedForSplit([]); setReceipt({ auditPublicId: response.auditPublicId, correlationId: response.correlationId }); if (action === "cancel") { localStorage.removeItem(`${storageScope()}:batch-id`); localStorage.removeItem(operationStorageKey("capture", sourceId)); localStorage.removeItem(operationStorageKey("execute", sourceId)); setBatchPublicId(null); setBatchRevision(0); setCaptureKey(crypto.randomUUID()); setExecuteKey(crypto.randomUUID()); setSplitResult(null); setItems([newItem()]); setStep(1); } else { const { data: destination } = await api.get(`/payment-batches/${response.destinationBatchPublicId}/workspace`) as { data: WorkspaceResponse }; setSplitResult({ ...response, destinationItemPublicIds: destination.items?.map((item) => item.publicId) ?? [] }); await refreshWorkspace(sourceId); } setMessage(t("paymentBatch.mutationComplete")); } catch (error) { setMessage(safeError(error)); } finally { setBusy(false); } };

    return <Card data-testid="payment-batch-editor"><CardHeader><CardTitle>{t("paymentBatch.title")}</CardTitle><div className="grid grid-cols-2 gap-1 text-xs md:grid-cols-4" aria-label={t("paymentBatch.steps")}>{["stepCapture", "stepReview", "stepChronology", "stepConfirm"].map((label, index) => <span key={label} className={`rounded px-2 py-1 ${step === index + 1 ? "bg-slate-900 text-white" : "border"}`}>{index + 1}. {t(`paymentBatch.${label}`)}</span>)}</div></CardHeader><CardContent className="space-y-4">
        <div className="rounded border border-dashed p-4" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (items.some((item) => !item.file && item.uploadStatus !== "ready") || (!batchPublicId && items.length < 50)) addFiles(event.dataTransfer.files); }}><p>{t("paymentBatch.dropzone")}</p><Input aria-label={t("paymentBatch.chooseFiles")} type="file" multiple accept="image/jpeg,image/png,application/pdf" disabled={busy || items.length >= 50 || Boolean(batchPublicId && items.every((item) => item.file || item.uploadStatus === "ready"))} onChange={uploadChange} /></div>
        {items.map((item) => <div className="grid gap-2 rounded border p-3 md:grid-cols-4" key={item.id} data-testid="payment-batch-row">
            <label className="grid gap-1 text-sm md:col-span-2">{t("paymentBatch.payerName")}<Input disabled={busy} value={item.payerName ?? ""} onChange={(event) => update(item.id, { payerName: event.target.value })} /></label>
            <label className="grid gap-1 text-sm md:col-span-2">{t("paymentBatchReference")}<Input disabled={busy} value={item.bankReference ?? ""} onChange={(event) => update(item.id, { bankReference: event.target.value })} /></label>
            <label className="grid gap-1 text-sm">{t("paymentBatch.amount")}<Input disabled={busy} inputMode="decimal" value={item.amount} onChange={(event) => update(item.id, { amount: event.target.value })} placeholder="0.00" /></label>
            <label className="grid gap-1 text-sm">{t("paymentBatch.receivedAt")}<Input disabled={busy} type="datetime-local" value={item.receivedAt} onChange={(event) => update(item.id, { receivedAt: event.target.value })} /></label>
            <label className="grid gap-1 text-sm">{t("paymentBatch.dueDate")}<Input type="date" value={item.targetDueDate} disabled={busy || Boolean(item.paymentIntakePublicId)} onChange={(event) => update(item.id, { targetDueDate: event.target.value })} /></label>
            <span className="text-xs md:col-span-2">{item.file?.name ?? (item.paymentIntakePublicId ? t("paymentBatch.resumed") : t("paymentBatch.noFile"))}</span>{batchPublicId && item.batchItemPublicId && <label className="text-xs"><input type="checkbox" checked={selectedForSplit.includes(item.batchItemPublicId)} onChange={(event) => setSelectedForSplit((current) => event.target.checked ? [...current, item.batchItemPublicId!] : current.filter((id) => id !== item.batchItemPublicId))} /> {t("paymentBatch.split")}</label>}
            {item.candidates && <div className="grid gap-2 md:col-span-4"><p className="text-sm">{item.candidates.reviewRequired ? t("paymentBatch.manualReview") : t("paymentBatch.candidateReady")}</p><label className="text-sm">{t("paymentBatch.selectBorrower")}<select className="ml-2 rounded border p-1" value={item.selectedBorrowerPublicId ?? ""} onChange={(event) => selectBorrower(item, event.target.value)}><option value="">{t("paymentBatch.chooseCandidate")}</option>{item.candidates.borrowerCandidates.map((candidate) => <option key={candidate.publicId} value={candidate.publicId}>{candidate.name} ({candidate.matchType ?? "candidate"})</option>)}</select></label>{(item.allocations ?? []).map((allocation, allocationIndex) => <div className="flex flex-wrap gap-2" key={`${item.id}-${allocationIndex}`}><select aria-label={t("paymentBatch.selectContract")} className="rounded border p-1" value={allocation.loanPublicId} onChange={(event) => selectLoan(item, allocationIndex, event.target.value)}><option value="">{t("paymentBatch.chooseContract")}</option>{item.candidates?.contractCandidates.filter((candidate) => candidate.borrowerPublicId === item.selectedBorrowerPublicId && candidate.eligible).map((candidate) => <option key={candidate.loanPublicId} value={candidate.loanPublicId}>{candidate.borrowerName} · {candidate.repaymentType} · {candidate.status} · {candidate.startDate ?? t("paymentBatchUnknownStart")} · {candidate.principalAmount ?? "0.00"}</option>)}</select><Input aria-label={t("paymentBatch.allocationAmount")} inputMode="decimal" value={allocation.amount} onChange={(event) => { const allocations = [...(item.allocations ?? [])]; allocations[allocationIndex] = { ...allocations[allocationIndex], amount: event.target.value }; update(item.id, { allocations }); }} /></div>)}<Button type="button" variant="outline" onClick={() => update(item.id, { allocations: [...(item.allocations ?? []), { loanPublicId: "", amount: "" }] })}>{t("paymentBatch.addContract")}</Button></div>}
            {item.candidates?.contractCandidates.filter((candidate) => candidate.borrowerPublicId === item.selectedBorrowerPublicId).map((candidate) => <div className="text-xs text-muted-foreground" key={`terms-${item.id}-${candidate.loanPublicId}`}>{candidate.borrowerName} · {candidate.repaymentType} · {candidate.status} · {candidate.startDate ?? t("paymentBatchUnknownStart")} · {candidate.principalAmount ?? "0.00"} · {t("paymentBatchDueComponents")}: {componentText(candidate.dueComponents, t)} · {t("paymentBatchProposalComponents")}: {componentText(candidate.proposalComponents, t)}</div>)}
            {item.allocations?.map((allocation, allocationIndex) => { const contract = item.candidates?.contractCandidates.find((candidate) => candidate.loanPublicId === allocation.loanPublicId); return contract?.schedules.length ? <select key={`schedule-${item.id}-${allocationIndex}`} aria-label={t("paymentBatch.schedule")} className="rounded border p-1" value={allocation.schedulePublicId ?? ""} onChange={(event) => selectSchedule(item, allocationIndex, event.target.value)}><option value="">{t("paymentBatch.schedulePlaceholder")}</option>{contract.schedules.map((schedule) => <option key={schedule.publicId} value={schedule.publicId}>{schedule.dueDate} · {schedule.status} · {schedule.remainingDue}</option>)}</select> : null; })}
            {item.paymentIntakePublicId && <Button type="button" variant="outline" disabled={busy} onClick={() => void editReviewedItem(item)}>{t("paymentBatch.editReviewed")}</Button>}{item.uploadStatus === "failed" && <Button type="button" variant="outline" disabled={busy} onClick={() => void captureFiles()}>{t("paymentBatch.retryFile")}</Button>}{item.error && <p role="alert" className="text-sm text-red-700">{item.error}</p>}
        </div>)}
        {!batchPublicId && <Button type="button" variant="outline" onClick={() => setItems((current) => [...current, newItem()])}>{t("paymentBatch.addItem")}</Button>}
        <p>{t("paymentBatch.total", { amount: normalizeMoney(total) })}</p><p className="text-xs text-muted-foreground" data-batch-revision={batchRevision}>{t("paymentBatch.noFinancialWrites")}</p>
        {preview && <div className="rounded border p-3 text-sm" data-testid="payment-batch-preview"><p>{t("paymentBatch.previewStatus", { status: preview.status, version: preview.version })}</p><p>{t("paymentBatch.allocationCount", { count: preview.allocations.length })}</p><ul>{preview.allocations.map((allocation, index) => <li key={`${allocation.itemPublicId}-${allocation.loanPublicId}-${allocation.amount}`}>{t("paymentBatchSequence", { number: index + 1 })} · {allocation.targetDueDate} · {allocationLabel(allocation)} · {allocation.amount} · {t("paymentBatchComponents")}: {componentText(allocation.calculatedComponents, t)}</li>)}</ul>{preview.warnings.map((warning) => <p className="text-amber-700" key={warning.code}>{t("paymentBatch.warning", { code: warning.code })}</p>)}{preview.warnings.length > 0 && <div className="mt-2"><Input aria-label={t("paymentBatch.decisionReason")} value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} placeholder={t("paymentBatch.decisionReason")} /><Button type="button" disabled={busy || !decisionReason.trim()} onClick={() => void decideAndRefresh()}>{t("paymentBatch.newPreview")}</Button></div>}</div>}
        {splitResult && <div className="rounded border border-amber-300 p-3 text-sm" data-testid="payment-batch-split-result"><p>{t("paymentBatchSplitComplete")}</p><p>{t("paymentBatchDestinationBatch")}: {splitResult.destinationBatchPublicId}</p><p>{t("paymentBatchDependency")}: {splitResult.dependencyPublicId}</p><p>{t("paymentBatchMovedMembers")}: {splitResult.destinationItemPublicIds?.join(", ")}</p><Button type="button" variant="outline" onClick={() => { localStorage.setItem(`${storageScope()}:batch-id`, splitResult.destinationBatchPublicId); window.location.reload(); }}>{t("paymentBatchOpenDestination")}</Button></div>}
        <label><input type="checkbox" disabled={busy || !preview} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> {t("paymentBatch.confirm")}</label>{decisionAcknowledged && <p className="text-sm text-emerald-700">{t("paymentBatch.decisionRecorded")}</p>}{receipt && <p className="text-xs" data-testid="payment-batch-receipt">{t("paymentBatchReceipt")}: {[receipt.receiptPublicId, receipt.auditPublicId, receipt.correlationId].filter(Boolean).join(" · ")}</p>}{message && <p role="status">{message}</p>}
        <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || items.every((item) => item.evidenceStatus === "ready")} onClick={() => void captureFiles()}>{t("paymentBatch.uploadReview")}</Button><Button type="button" disabled={busy || !batchPublicId || reviewed} onClick={() => void reviewItems()}>{t("paymentBatch.reviewed")}</Button><Button type="button" disabled={busy || !reviewed || items.some((item) => item.reviewedEditPending)} onClick={() => void previewBatch()}>{t("paymentBatch.preview")}</Button><Button type="button" disabled={busy || !ready} onClick={() => void executeBatch()}>{t("paymentBatch.execute")}</Button>{batchPublicId && <><Button type="button" variant="outline" disabled={busy} onClick={() => void mutateBatch("split")}>{t("paymentBatch.split")}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void mutateBatch("cancel")}>{t("paymentBatch.cancelBatch")}</Button></>}</div>
    </CardContent></Card>;
}
