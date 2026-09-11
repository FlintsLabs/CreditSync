import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";

export function PaymentCancelDialog({ open, busy, amount, receivedAt, blockedReason, batchPublicId, onCancel, onConfirm }: { open: boolean; busy: boolean; amount?: string; receivedAt?: string; blockedReason?: string | null; batchPublicId?: string | null; onCancel: () => void; onConfirm: (reason: string) => void }) {
    const { t } = useTranslation();
    const [reason, setReason] = useState("");
    if (!open) return null;
    return <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
        <DialogContent aria-describedby="payment-cancel-description" className="border-destructive/40">
            <DialogHeader><DialogTitle>{t("payments.cancel.title")}</DialogTitle><DialogDescription id="payment-cancel-description">{t("payments.cancel.description")}</DialogDescription></DialogHeader>
            {amount && <div className="rounded bg-muted/50 p-2 text-sm">{t("payments.amount")}: <span className="font-medium tabular-nums">{amount}</span>{receivedAt && <span className="ml-3 text-muted-foreground">{receivedAt}</span>}</div>}
            {blockedReason && <div role="alert" className="rounded border border-amber-400/40 bg-amber-400/10 p-3 text-sm">{t(`payments.errors.${blockedReason}`, { defaultValue: blockedReason })}{batchPublicId && <a className="ml-2 underline" href={`?batch=1&batchId=${batchPublicId}`}>{t("payments.cancel.openBatch")}</a>}</div>}
            {!blockedReason && <label className="grid gap-1 text-sm" htmlFor="payment-cancel-reason">{t("payments.cancel.reason")}<Input id="payment-cancel-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} autoFocus /></label>}
            <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{t("common.cancel")}</Button>{!blockedReason && <Button type="button" variant="destructive" disabled={busy || !reason.trim()} onClick={() => onConfirm(reason)}>{t("payments.cancel.confirm")}</Button>}</DialogFooter>
        </DialogContent>
    </Dialog>;
}
