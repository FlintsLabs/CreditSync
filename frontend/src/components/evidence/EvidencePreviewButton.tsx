import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Eye, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

export interface EvidenceDescriptor { url: string; mimeType?: string | null }

interface EvidencePreviewButtonProps {
    available: boolean;
    label: string;
    mimeType?: string | null;
    resolve: () => Promise<EvidenceDescriptor>;
}

export function EvidencePreviewButton({ available, label, mimeType, resolve }: EvidencePreviewButtonProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [descriptor, setDescriptor] = useState<EvidenceDescriptor | null>(null);
    const [failed, setFailed] = useState(false);
    const requestGeneration = useRef(0);
    useEffect(() => () => { requestGeneration.current += 1; }, []);

    const load = useCallback(async () => {
        const generation = ++requestGeneration.current;
        setLoading(true);
        setFailed(false);
        setDescriptor(null);
        try {
            const next = await resolve();
            if (generation !== requestGeneration.current) return;
            setDescriptor({ ...next, mimeType: next.mimeType ?? mimeType ?? null });
        } catch {
            if (generation !== requestGeneration.current) return;
            setDescriptor(null);
            setFailed(true);
        } finally {
            if (generation === requestGeneration.current) setLoading(false);
        }
    }, [mimeType, resolve]);

    if (!available) return null;
    const resolvedType = descriptor?.mimeType ?? mimeType ?? "";
    const isImage = resolvedType.startsWith("image/");
    const isPdf = resolvedType === "application/pdf";

    return <>
        <Button size="sm" variant="outline" type="button" onClick={() => { setOpen(true); void load(); }}>
            <Eye className="mr-2 h-4 w-4" />{label}
        </Button>
        <Dialog open={open} onOpenChange={(next) => {
            setOpen(next);
            if (!next) { requestGeneration.current += 1; setDescriptor(null); setFailed(false); setLoading(false); }
        }}>
            <DialogContent className="max-h-[92vh] max-w-4xl overflow-hidden">
                <DialogHeader><DialogTitle>{label}</DialogTitle><DialogDescription>{t("evidence.description")}</DialogDescription></DialogHeader>
                <div className="flex min-h-72 items-center justify-center overflow-auto rounded border bg-muted/20 p-2 sm:min-h-[60vh]">
                    {loading && <div role="status" className="flex items-center text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />{t("evidence.loading")}</div>}
                    {failed && <div role="alert" className="space-y-3 text-center"><p className="text-destructive">{t("evidence.failed")}</p><Button type="button" variant="outline" onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" />{t("evidence.retry")}</Button></div>}
                    {descriptor && isImage && <img src={descriptor.url} alt={label} className="max-h-[72vh] max-w-full object-contain" />}
                    {descriptor && isPdf && <iframe src={descriptor.url} title={label} className="h-[68vh] w-full rounded bg-background" />}
                    {descriptor && !isImage && !isPdf && <p className="text-sm text-muted-foreground">{t("evidence.unsupported")}</p>}
                </div>
                {descriptor && <DialogFooter><Button type="button" variant="outline" onClick={() => window.open(descriptor.url, "_blank", "noopener,noreferrer")}><ExternalLink className="mr-2 h-4 w-4" />{t("evidence.openNewTab")}</Button></DialogFooter>}
            </DialogContent>
        </Dialog>
    </>;
}
