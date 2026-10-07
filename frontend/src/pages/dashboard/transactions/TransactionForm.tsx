import { useEffect, useMemo, useRef, useState } from "react";
import { FinancialDecimal as Decimal } from "../../../lib/financial-decimal";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../../components/ui/dialog";
import { ChevronDown, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { unsignedMoneyInputPattern } from "../../../lib/financial-decimal";
import { formatDecimalExact, formatMoneyExact } from "../../../lib/workflow-model";
import { bangkokReceiptInput, bangkokReceiptTimestamp, buildReceiptAllocations, receiptAllocationTotal, type ReceiptAllocationDraft } from "./transaction-entry-model";
import { submitReceiptForReview, type ReceiptEntryProgress, type ReceiptEntrySnapshot } from "./transaction-entry-workflow";
import type { HttpClient } from "../../../lib/workflow-api";

interface LoanOption { id: string; publicId: string; borrowerPublicId: string; borrowerName: string; principal: string; repaymentType?: string; status?: string }
interface BorrowerOption { publicId: string; name: string }
interface LoanScheduleItem { id: string; publicId: string; installmentNo: number; dueDate: string; remainingDue: string; totalDueNow?: string; status: string }
interface AllocationRow extends ReceiptAllocationDraft { scheduleItems: LoanScheduleItem[]; loadingSchedule: boolean }

const emptyRow = (): AllocationRow => ({ id: crypto.randomUUID(), borrowerPublicId: "", loanPublicId: "", schedulePublicId: "", amount: "", scheduleItems: [], loadingSchedule: false });
function ungroup(value: string, locale: string) {
    const group = new Intl.NumberFormat(locale).formatToParts(1000).find((part) => part.type === "group")?.value ?? ",";
    return value.split(group).join("").replace(/[\s\u00a0\u202f]/g, "");
}
function formatInput(value: string, locale: string) {
    const normalized = ungroup(value, locale);
    if (!unsignedMoneyInputPattern.test(normalized)) return value;
    return formatDecimalExact(normalized, locale);
}
function validAmount(value: string, locale: string) {
    const amount = ungroup(value, locale);
    return unsignedMoneyInputPattern.test(amount) && new Decimal(amount).isPositive();
}

export default function TransactionForm() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const requestedLoanId = searchParams.get("loanId") ?? "";
    const requestedBorrowerId = searchParams.get("borrowerId") ?? "";
    const [loans, setLoans] = useState<LoanOption[]>([]);
    const [borrowers, setBorrowers] = useState<BorrowerOption[]>([]);
    const [rows, setRows] = useState<AllocationRow[]>(() => [{ ...emptyRow(), borrowerPublicId: requestedBorrowerId, loanPublicId: requestedLoanId, schedulePublicId: searchParams.get("scheduleId") ?? "" }]);
    const [payerName, setPayerName] = useState("");
    const payerTouched = useRef(false);
    const [receivedAt, setReceivedAt] = useState(() => bangkokReceiptInput(new Date().toISOString()));
    const [receiptAmount, setReceiptAmount] = useState("");
    const [bankReference, setBankReference] = useState("");
    const [notes, setNotes] = useState("");
    const [files, setFiles] = useState<File[]>([]);
    const [uploading, setUploading] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const [retainedDraft, setRetainedDraft] = useState("");
    const [reviewTarget, setReviewTarget] = useState("");
    const [showLeaveDisclosure, setShowLeaveDisclosure] = useState(false);
    const [submittedSnapshot, setSubmittedSnapshot] = useState<ReceiptEntrySnapshot | null>(null);
    const [progress, setProgress] = useState<ReceiptEntryProgress>({ files: {} });
    const [focusedAmountId, setFocusedAmountId] = useState("");
    const cancelButtonRef = useRef<HTMLButtonElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const scheduleRequestIds = useRef(new Map<string, number>());
    const scheduleRequestKey = rows.map((row) => `${row.id}:${row.loanPublicId}`).join("|");

    useEffect(() => {
        Promise.all([api.get("/borrowers"), api.get("/loans")])
            .then(([borrowerResponse, loanResponse]) => {
                const loadedBorrowers = borrowerResponse.data ?? [];
                const loadedLoans = (loanResponse.data ?? []).filter((loan: LoanOption) => loan.status === "active");
                setBorrowers(loadedBorrowers);
                setLoans(loadedLoans);
                const origin = loadedLoans.find((loan: LoanOption) => loan.publicId === requestedLoanId);
                if (origin) {
                    setRows((current) => current.map((row) => row.id === current[0]?.id && row.loanPublicId === requestedLoanId ? { ...row, borrowerPublicId: origin.borrowerPublicId, loanPublicId: origin.publicId } : row));
                    if (!payerTouched.current) setPayerName(origin.borrowerName);
                }
            })
            .catch(() => setErrorMessage("LOAD_LOANS_FAILED"));
    }, [requestedLoanId]); // Load once so a language switch cannot reset operator input.

    useEffect(() => {
        rows.forEach((row) => {
            if (!row.loanPublicId) return;
            const requestId = (scheduleRequestIds.current.get(row.id) ?? 0) + 1;
            scheduleRequestIds.current.set(row.id, requestId);
            const selectedLoan = loans.find((loan) => loan.publicId === row.loanPublicId);
            if (selectedLoan?.repaymentType === "floating") {
                setRows((current) => current.map((item) => item.id === row.id ? { ...item, scheduleItems: [], schedulePublicId: "", loadingSchedule: false } : item));
                return;
            }
            setRows((current) => current.map((item) => item.id === row.id ? { ...item, loadingSchedule: true } : item));
            api.get(`/loans/${row.loanPublicId}/schedule`).then((response) => {
                const items: LoanScheduleItem[] = (response.data ?? []).filter((item: LoanScheduleItem) => new Decimal(item.remainingDue).isPositive());
                setRows((current) => current.map((item) => {
                    if (item.id !== row.id || item.loanPublicId !== row.loanPublicId || scheduleRequestIds.current.get(row.id) !== requestId) return item;
                    const desired = item.schedulePublicId;
                    const selected = items.find((schedule) => (schedule.publicId ?? schedule.id) === desired) ?? items[0];
                    const unchanged = item.amount.trim() === "";
                    return { ...item, scheduleItems: items, loadingSchedule: false,
                        schedulePublicId: selected ? (selected.publicId ?? selected.id) : "",
                        ...(unchanged && selected ? { amount: selected.totalDueNow ?? selected.remainingDue } : {}),
                        ...(!selected ? { schedulePublicId: "" } : {}),
                    };
                }));
            }).catch(() => setRows((current) => current.map((item) => item.id === row.id && scheduleRequestIds.current.get(row.id) === requestId ? { ...item, loadingSchedule: false, scheduleItems: [] } : item)));
        });
        // scheduleRequestKey tracks only row identity/loan changes and intentionally ignores allocation edits.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scheduleRequestKey, loans]);

    const total = useMemo(() => {
        try { return receiptAllocationTotal(rows, i18n.language); }
        catch { return "0.00"; }
    }, [rows, i18n.language]);
    const allocationValid = (() => {
        try { buildReceiptAllocations(rows, i18n.language); return receiptAllocationTotal(rows, i18n.language).length > 0; }
        catch { return false; }
    })();
    const locked = uploading || Boolean(submittedSnapshot) || Boolean(reviewTarget);
    const effectiveReceiptAmount = ungroup(receiptAmount, i18n.language);
    const receiptDifference = (() => {
        if (!files.length || !unsignedMoneyInputPattern.test(effectiveReceiptAmount)) return "0.00";
        return new Decimal(effectiveReceiptAmount).minus(total).toFixed(2);
    })();
    const receiptMatchesAllocations = !files.length || (validAmount(receiptAmount, i18n.language) && receiptDifference === "0.00");
    const validationMessage = (() => {
        try { buildReceiptAllocations(rows, i18n.language); receiptAllocationTotal(rows, i18n.language); return ""; }
        catch (error) {
            const message = error instanceof Error ? error.message : "";
            const duplicateTarget = message.includes("Duplicate");
            const totalBound = message.includes("bound");
            return t(duplicateTarget ? "transactionsForm.errors.duplicateTarget" : totalBound ? "transactionsForm.errors.totalBound" : "transactionsForm.errors.allocationInvalid",
                duplicateTarget ? "Remove a repeated contract and installment allocation." : totalBound ? "The allocation total exceeds the public payment limit." : "Enter a positive amount for each contract and check the total.");
        }
    })();
    const editRow = (id: string, patch: Partial<AllocationRow>) => setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));

    const selectBorrower = (id: string, rowId: string) => {
        const candidates = loans.filter((loan) => loan.borrowerPublicId === id);
        editRow(rowId, { borrowerPublicId: id, loanPublicId: candidates.length === 1 ? candidates[0]!.publicId : "", schedulePublicId: "", scheduleItems: [], amount: "" });
    };

    const selectLoan = (id: string, rowId: string) => {
        const loan = loans.find((item) => item.publicId === id);
        editRow(rowId, { loanPublicId: id, schedulePublicId: "", scheduleItems: [], amount: "" });
        if (loan && !payerName && rows.length === 1) setPayerName(loan.borrowerName);
    };

    const selectFiles = (selected: FileList | null) => {
        if (!selected || locked) return;
        const next = [...files, ...Array.from(selected)];
        if (next.length > 20) { setErrorMessage(t("transactionsForm.errors.fileCount", "Choose no more than 20 supporting files.")); return; }
        if (next.some((file) => !["image/jpeg", "image/png", "application/pdf"].includes(file.type))) { setErrorMessage(t("transactionsForm.errors.fileType", "Supporting files must be JPEG, PNG, or PDF.")); return; }
        setErrorMessage("");
        setFiles(next);
    };

    const makeSnapshot = (): ReceiptEntrySnapshot => {
        const allocations = buildReceiptAllocations(rows, i18n.language);
        if (allocations.some((allocation) => !allocation.schedulePublicId && loans.find((loan) => loan.publicId === allocation.loanPublicId)?.repaymentType !== "floating")) {
            throw new Error(t("transactionsForm.errors.schedule", "Select an available installment for each scheduled agreement."));
        }
        return {
            receipt: {
                amount: files.length ? effectiveReceiptAmount : total,
                receivedAt: bangkokReceiptTimestamp(receivedAt),
                payerName: payerName.trim() || undefined,
                bankReference: bankReference.trim() || undefined,
                notes: notes.trim() || undefined,
                originLoanPublicId: rows.length === 1 ? rows[0]?.loanPublicId || undefined : undefined,
            },
            allocations,
            files: [...files],
            context: { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() },
        };
    };

    const submit = async () => {
        setUploading(true);
        setErrorMessage("");
        try {
            const snapshot = submittedSnapshot ?? makeSnapshot();
            if (!submittedSnapshot) setSubmittedSnapshot(snapshot);
            const nextProgress = { intakePublicId: progress.intakePublicId, files: { ...progress.files } };
            const result = await submitReceiptForReview(api as unknown as HttpClient, snapshot, nextProgress, (next) => setProgress(next));
            setProgress(nextProgress);
            navigate(`/payments?${new URLSearchParams({ intake: result.intakePublicId }).toString()}`);
        } catch (error: unknown) {
            const failure = error as { code?: string; intakePublicId?: string; reviewTargetPublicId?: string; httpStatus?: number; response?: { data?: { code?: string } } };
            if (failure.intakePublicId) {
                setProgress((current) => ({ ...current, intakePublicId: failure.intakePublicId }));
                setRetainedDraft(failure.intakePublicId);
            }
            if (failure.reviewTargetPublicId) {
                setReviewTarget(failure.reviewTargetPublicId);
                setRetainedDraft("");
            }
            if (!progress.intakePublicId && !failure.reviewTargetPublicId && ["TOO_MANY_EVIDENCE_FILES", "UNSUPPORTED_EVIDENCE_TYPE", "DUPLICATE_EVIDENCE", "EVIDENCE_HASH_FAILED"].includes(failure.code ?? "")) setSubmittedSnapshot(null);
            if (!progress.intakePublicId && !failure.intakePublicId && !failure.reviewTargetPublicId
                && failure.httpStatus !== undefined && failure.httpStatus >= 400 && failure.httpStatus < 500) setSubmittedSnapshot(null);
            const errorCode = failure.response?.data?.code ?? failure.code;
            const fallback = t("transactionsForm.errors.recordFailed", "Unable to save this receipt. Retry the same request or open its saved draft.");
            const localDuplicate = errorCode === "DUPLICATE_EVIDENCE" && !progress.intakePublicId && !failure.intakePublicId && !failure.reviewTargetPublicId;
            const localKey = localDuplicate ? "transactionsForm.errors.duplicateFiles" : `transactionsForm.errors.${errorCode}`;
            const domainKey = `domainErrors.${errorCode}`;
            setErrorMessage(errorCode && i18n.exists(localKey) ? t(localKey)
                : errorCode && i18n.exists(domainKey) ? t(domainKey) : fallback);
        } finally { setUploading(false); }
    };

    const cancel = () => {
        if (progress.intakePublicId || reviewTarget || submittedSnapshot) { setShowLeaveDisclosure(true); return; }
        navigate(requestedLoanId ? `/loans/${requestedLoanId}?tab=payments` : "/transactions");
    };
    const leaveDestination = requestedLoanId ? `/loans/${requestedLoanId}?tab=payments` : "/transactions";

    return <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-3xl font-bold tracking-tight">{t("transactionsForm.title", "Record Repayment")}</h2>
            <a href="/payments?batch=1" className="inline-flex h-10 w-full items-center justify-center whitespace-nowrap rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"><Upload className="mr-2 h-4 w-4" />{t("transactionsForm.batchUpload", "Record separate transfers")}</a>
        </div>
        {errorMessage && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{errorMessage === "LOAD_LOANS_FAILED" ? t("transactionsForm.errors.loadLoans", "Unable to load loans.") : errorMessage}</div>}
        {(retainedDraft || reviewTarget) && <div className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"><p>{reviewTarget ? t("transactionsForm.duplicateReview", "This receipt matches an existing or conflicting record. Review it before making another payment entry.") : t("transactionsForm.retainedDraft", "This unposted payment draft remains saved. Leaving this form will not cancel or delete it.")}</p><a className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md border border-input bg-background px-4 py-2 font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" href={`/payments?intake=${encodeURIComponent(reviewTarget || retainedDraft)}`}>{reviewTarget ? t("transactionsForm.openReview", "Open receipt review") : t("transactionsForm.openDraft", "Open saved draft")}</a></div>}
        <Dialog open={showLeaveDisclosure} onOpenChange={setShowLeaveDisclosure}>
            <DialogContent closeLabel={t("common.close", "Close")} className="motion-reduce:animate-none!" onCloseAutoFocus={(event) => { event.preventDefault(); cancelButtonRef.current?.focus(); }}>
                <DialogHeader><DialogTitle>{t("transactionsForm.leaveTitle", "Leave payment form?")}</DialogTitle><DialogDescription>
                    {progress.intakePublicId ? t("transactionsForm.retainedDraft") : reviewTarget ? t("transactionsForm.duplicateReview") : t("transactionsForm.unknownOutcome", "The outcome of this receipt request is unknown. A receipt may have been saved. Retry the same request before leaving to avoid duplicates.")}
                </DialogDescription></DialogHeader>
                <DialogFooter><Button type="button" variant="outline" onClick={() => setShowLeaveDisclosure(false)}>{t("transactionsForm.stay", "Stay here")}</Button><Button type="button" onClick={() => navigate(leaveDestination)}>{t("transactionsForm.leaveForm", "Leave form")}</Button></DialogFooter>
            </DialogContent>
        </Dialog>

        <Card><CardHeader><CardTitle>{t("transactionsForm.details", "Receipt and allocations")}</CardTitle></CardHeader><CardContent className="space-y-6">
            <section aria-labelledby="allocation-heading" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3"><h3 id="allocation-heading" className="text-lg font-semibold">{t("transactionsForm.allocations", "Contract allocations")}</h3><Button type="button" variant="outline" disabled={locked} onClick={() => setRows((current) => [...current, emptyRow()])}><Plus className="mr-2 h-4 w-4" />{t("transactionsForm.addContract", "Add contract")}</Button></div>
                <div className="space-y-4">
                    {rows.map((row, index) => {
                        const borrowerLoans = loans.filter((loan) => loan.borrowerPublicId === row.borrowerPublicId);
                        const loan = loans.find((item) => item.publicId === row.loanPublicId);
                        const floating = loan?.repaymentType === "floating";
                        const scheduleId = `schedule-${row.id}`;
                        const amountId = `amount-${row.id}`;
                        return <div key={row.id} className="grid gap-4 rounded-md border p-4 md:grid-cols-[1fr_1.2fr_1.4fr_1fr_auto] md:items-end">
                            <div className="grid gap-2"><label htmlFor={`borrower-${row.id}`}>{index ? t("transactionsForm.borrowerRow", "Borrower {{number}}", { number: index + 1 }) : t("transactionsForm.borrower", "Borrower")}</label><div className="relative"><select id={`borrower-${row.id}`} aria-label={index ? t("transactionsForm.borrowerRow", "Borrower {{number}}", { number: index + 1 }) : t("transactionsForm.borrower", "Borrower")} className="flex h-10 w-full appearance-none rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm" value={row.borrowerPublicId} disabled={locked} onChange={(event) => selectBorrower(event.target.value, row.id)}><option value="">{t("transactionsForm.selectBorrower", "Select borrower...")}</option>{borrowers.map((borrower) => <option key={borrower.publicId} value={borrower.publicId}>{borrower.name}</option>)}</select><ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /></div></div>
                            <div className="grid gap-2"><label htmlFor={`loan-${row.id}`}>{t("transactionsForm.loan", "Agreement")}</label><div className="relative"><select id={`loan-${row.id}`} className="flex h-10 w-full appearance-none rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm" value={row.loanPublicId} disabled={!row.borrowerPublicId || locked} onChange={(event) => selectLoan(event.target.value, row.id)}><option value="">{t("transactionsForm.selectLoan", "Select Loan...")}</option>{borrowerLoans.map((item) => <option key={item.publicId} value={item.publicId}>{t("transactionsForm.loanOption", { defaultValue: "Loan #{{id}} - {{name}} (Principal: {{amount}})", id: item.id, name: item.borrowerName, amount: formatMoneyExact(String(item.principal), i18n.language) })}</option>)}</select><ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /></div></div>
                            <div className="grid gap-2">{floating ? <><label>{t("transactionsForm.installment", "Installment")}</label><div role="status" className="flex min-h-10 items-center rounded-md border bg-muted/30 p-2 text-sm text-muted-foreground">{t("transactionsForm.floatingNoScheduleShort", "No fixed installments (floating)")}</div></> : <><label htmlFor={scheduleId}>{t("transactionsForm.installment", "Installment")}</label><div className="relative"><select id={scheduleId} className="flex h-10 w-full appearance-none rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm" value={row.schedulePublicId} disabled={!row.loanPublicId || row.loadingSchedule || row.scheduleItems.length === 0 || locked} onChange={(event) => { const chosen = row.scheduleItems.find((item) => (item.publicId ?? item.id) === event.target.value); editRow(row.id, { schedulePublicId: event.target.value, ...(chosen ? { amount: chosen.totalDueNow ?? chosen.remainingDue } : {}) }); }}><option value="">{row.loadingSchedule ? t("common.loading", "Loading...") : row.scheduleItems.length ? t("transactionsForm.noSchedule", "Select installment") : t("transactionsForm.noScheduleAvailable", "No remaining installments")}</option>{row.scheduleItems.map((item) => <option key={item.publicId ?? item.id} value={item.publicId ?? item.id}>#{item.installmentNo} • {item.dueDate} • {formatMoneyExact(item.totalDueNow ?? item.remainingDue, i18n.language)}</option>)}</select><ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /></div></>}</div>
                            <div className="grid gap-2"><label htmlFor={amountId}>{t("transactionsForm.allocationAmount", "Allocation amount (฿)")} <span className="sr-only">{index + 1}</span></label><Input id={amountId} aria-label={t("transactionsForm.allocationAmountRow", "Allocation amount {{number}}", { number: index + 1 })} type="text" inputMode="decimal" placeholder="0.00" value={focusedAmountId === row.id ? row.amount : formatInput(row.amount, i18n.language)} disabled={locked} onFocus={(event) => { setFocusedAmountId(row.id); editRow(row.id, { amount: ungroup(event.currentTarget.value, i18n.language) }); }} onChange={(event) => editRow(row.id, { amount: event.target.value })} onBlur={(event) => { setFocusedAmountId(""); editRow(row.id, { amount: formatInput(event.currentTarget.value, i18n.language) }); }} /></div>
                            <Button type="button" variant="outline" aria-label={t("transactionsForm.removeContract", { defaultValue: "Remove contract {{number}}", number: index + 1 })} disabled={locked || rows.length === 1} onClick={() => { scheduleRequestIds.current.delete(row.id); setRows((current) => current.filter((item) => item.id !== row.id)); }}><Trash2 className="h-4 w-4" /><span className="sr-only">{t("transactionsForm.remove", "Remove")}</span></Button>
                        </div>;
                    })}
                </div>
                {rows.some((row) => loans.find((loan) => loan.publicId === row.loanPublicId)?.repaymentType === "floating") && <p className="text-sm text-muted-foreground">{t("transactionsForm.floatingNoSchedule")}</p>}
            </section>

            <div className="grid gap-4 md:grid-cols-2">
                {files.length > 0 && <div className="grid gap-2"><label htmlFor="receipt-amount">{t("transactionsForm.receiptAmount", "Slip / receipt amount (฿)")}</label><Input id="receipt-amount" aria-label={t("transactionsForm.receiptAmount", "Slip / receipt amount (฿)")} inputMode="decimal" placeholder="0.00" value={receiptAmount} disabled={locked} onChange={(event) => setReceiptAmount(event.target.value)} onBlur={(event) => setReceiptAmount(formatInput(event.currentTarget.value, i18n.language))} /><p className="text-xs text-muted-foreground">{t("transactionsForm.receiptAmountHint", "Enter the amount shown on the receipt. It must equal the allocation total.")}</p></div>}
                <div className="grid gap-2"><label htmlFor="payer-name">{t("transactionsForm.payer", "Payer name")}</label><Input id="payer-name" value={payerName} disabled={locked} onChange={(event) => { payerTouched.current = true; setPayerName(event.target.value); }} /></div>
                <div className="grid gap-2"><label htmlFor="received-at">{t("transactionsForm.receivedAt", "Received date and time (Bangkok)")}</label><Input id="received-at" className="[color-scheme:light] dark:[color-scheme:dark]" type="datetime-local" value={receivedAt} disabled={locked} onChange={(event) => setReceivedAt(event.target.value)} /></div>
                <div className="grid gap-2"><label htmlFor="bank-reference">{t("transactionsForm.reference", "Bank reference")}</label><Input id="bank-reference" value={bankReference} disabled={locked} onChange={(event) => setBankReference(event.target.value)} /><p className="text-xs text-muted-foreground">{t("transactionsForm.referenceHint", "Optional transfer reference. Do not enter an account number.")}</p></div>
                <div className="grid gap-2"><label htmlFor="notes">{t("transactionsForm.notes", "Notes")}</label><Input id="notes" value={notes} disabled={locked} onChange={(event) => setNotes(event.target.value)} /><p className="text-xs text-muted-foreground">{t("transactionsForm.notesHint", "Optional context that helps review this payment.")}</p></div>
            </div>

            <section className="space-y-3 rounded-md border p-4" aria-labelledby="evidence-heading"><div><h3 id="evidence-heading" className="font-semibold">{t("transactionsForm.evidence", "Supporting files (optional)")}</h3><p className="text-sm text-muted-foreground">{t("transactionsForm.evidenceHint", "Attach up to 20 JPEG, PNG, or PDF files to this shared receipt.")}</p></div><Button type="button" variant="outline" disabled={locked || files.length >= 20} onClick={() => fileInputRef.current?.click()}><Upload className="mr-2 h-4 w-4" />{t("transactionsForm.addFiles", "Add supporting files")}</Button><Input ref={fileInputRef} className="hidden" tabIndex={-1} aria-label={t("transactionsForm.addFiles", "Add supporting files")} type="file" accept="image/jpeg,image/png,application/pdf" multiple disabled={locked || files.length >= 20} onChange={(event) => { selectFiles(event.target.files); event.currentTarget.value = ""; }} />{files.length > 0 && <ul className="space-y-2">{files.map((file, index) => <li key={`${file.name}-${index}`} className="flex items-center justify-between gap-3 text-sm"><span className="min-w-0 truncate">{file.name} <span className="text-muted-foreground">{progress.files[Object.keys(progress.files)[index] ?? ""]?.status === "ready" ? t("transactionsForm.fileReady", "Ready") : t("transactionsForm.filePending", "Selected")}</span></span><Button type="button" variant="outline" disabled={locked} aria-label={t("transactionsForm.removeFile", { defaultValue: "Remove {{name}}", name: file.name })} onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="h-4 w-4" /></Button></li>)}</ul>}</section>

            <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm text-muted-foreground">{t("transactionsForm.receiptTotal", "Receipt total")}</p><p className="text-2xl font-semibold tabular-nums">{formatMoneyExact(files.length && validAmount(receiptAmount, i18n.language) ? effectiveReceiptAmount : total, i18n.language)}</p></div><div className="text-sm text-muted-foreground">{files.length ? <><p>{t("transactionsForm.allocationTotal", "Allocation total")}: {formatMoneyExact(total, i18n.language)}</p><p role="status">{t("transactionsForm.difference", "Difference")}: {formatMoneyExact(receiptDifference, i18n.language)}</p></> : <p>{t("transactionsForm.totalDescription", "This total is the exact sum of all contract allocations.")}</p>}</div></div>
            {validationMessage && <p role="alert" className="text-sm text-destructive">{validationMessage}</p>}
            {files.length > 0 && !receiptMatchesAllocations && <p role="alert" className="text-sm text-destructive">{t(receiptAmount && unsignedMoneyInputPattern.test(effectiveReceiptAmount) ? "transactionsForm.errors.receiptMismatch" : "transactionsForm.errors.receiptAmount", receiptAmount && unsignedMoneyInputPattern.test(effectiveReceiptAmount) ? "Receipt amount must exactly match the allocation total." : "Enter the amount shown on the receipt.")}</p>}
            <p className="text-xs text-muted-foreground">{t("transactionsForm.intakeNotice", "Review this receipt and its allocations before posting. It will not be posted automatically.")}</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button ref={cancelButtonRef} type="button" variant="outline" className="w-full sm:w-auto" onClick={cancel} disabled={uploading}>{t("common.cancel", "Cancel")}</Button><Button className="w-full sm:w-auto" onClick={() => void submit()} disabled={!allocationValid || !receiptMatchesAllocations || !rows.every((row) => row.loanPublicId && validAmount(row.amount, i18n.language)) || uploading || Boolean(reviewTarget)}>{uploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{uploading ? t("transactionsForm.retrying", "Saving receipt...") : retainedDraft ? t("transactionsForm.retry", "Retry saved receipt") : t("transactionsForm.submit", "Review payment")}</Button></div>
        </CardContent></Card>
    </div>;
}
