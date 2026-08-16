import { useEffect, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import { Loader2, Pencil, Plus, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { bangkokLocalDateTimeToIso } from "../../../lib/bangkok-time";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../components/ui/table";

interface Participant {
    publicId: string;
    intermediaryPublicId: string;
    intermediaryName?: string;
    intermediaryAliases?: string[] | null;
    commissionRate: string;
    role: string;
    note?: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
    status: "active" | "ended";
}

interface Intermediary { publicId: string; name: string; aliases?: string[] | null }
type Mode = "add" | "update" | "end";

const initialForm = { intermediaryPublicId: "", commissionRate: "", role: "", effectiveAt: "", note: "", confirmed: false };
const ratePattern = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/;

function domainMessage(error: unknown, fallback: string) {
    const data = (error as { response?: { data?: { message?: string; error?: string } } }).response?.data;
    return data?.message ?? data?.error ?? fallback;
}

export function LoanAgentsTab({ loanPublicId }: { loanPublicId: string }) {
    const { t, i18n } = useTranslation();
    const [participants, setParticipants] = useState<Participant[]>([]);
    const [intermediaries, setIntermediaries] = useState<Intermediary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [mode, setMode] = useState<Mode | null>(null);
    const [selected, setSelected] = useState<Participant | null>(null);
    const [form, setForm] = useState(initialForm);
    const [saving, setSaving] = useState(false);
    const commandIntentRef = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);

    const load = async () => {
        setLoading(true);
        setError("");
        try {
            const [participantsResponse, intermediariesResponse] = await Promise.all([
                api.get(`/loans/${loanPublicId}/commission-participants`),
                api.get("/intermediaries?status=active"),
            ]);
            setParticipants(participantsResponse.data ?? []);
            setIntermediaries(intermediariesResponse.data?.items ?? intermediariesResponse.data ?? []);
            return true;
        } catch (loadError) {
            setError(domainMessage(loadError, t("loanDetail.agents.errors.load", "Unable to load agents.")));
            return false;
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        const timer = window.setTimeout(() => { void load(); }, 0);
        return () => window.clearTimeout(timer);
    }, [loanPublicId]); // eslint-disable-line react-hooks/exhaustive-deps

    const intermediaryById = useMemo(() => new Map(intermediaries.map((item) => [item.publicId, item])), [intermediaries]);
    const totalRate = participants.filter((item) => item.status === "active").reduce((sum, item) => sum.plus(item.commissionRate), new Decimal(0)).toFixed(4);
    const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeZone: "Asia/Bangkok" }).format(new Date(value)) : "—";

    const open = (nextMode: Mode, participant?: Participant) => {
        setMode(nextMode);
        setSelected(participant ?? null);
        setError("");
        setForm(participant ? {
            intermediaryPublicId: participant.intermediaryPublicId,
            commissionRate: participant.commissionRate,
            role: participant.role,
            effectiveAt: "",
            note: "",
            confirmed: false,
        } : initialForm);
    };

    const submit = async () => {
        if (!mode || saving) return;
        if (!form.confirmed) { setError(t("loanDetail.agents.errors.confirm", "Confirm this change before saving.")); return; }
        if (mode !== "end") {
            if (!ratePattern.test(form.commissionRate) || !new Decimal(form.commissionRate || 0).gt(0) || new Decimal(form.commissionRate || 0).gt(100)) {
                setError(t("loanDetail.agents.errors.rate", "Commission rate must be greater than 0 and at most 100 with up to four decimals."));
                return;
            }
            if (!form.role.trim() || (mode === "add" && !form.intermediaryPublicId)) {
                setError(t("loanDetail.agents.errors.required", "Agent and role are required.")); return;
            }
        } else if (!form.note.trim()) { setError(t("loanDetail.agents.errors.reason", "An end reason is required.")); return; }
        if (!form.effectiveAt) { setError(t("loanDetail.agents.errors.date", "Choose an effective date and time.")); return; }

        setSaving(true);
        setError("");
        try {
            const effectiveAt = bangkokLocalDateTimeToIso(form.effectiveAt);
            const command = mode === "add" ? {
                method: "post" as const,
                url: `/loans/${loanPublicId}/commission-participants`,
                body: { intermediaryPublicId: form.intermediaryPublicId, commissionRate: form.commissionRate, role: form.role.trim(), effectiveFrom: effectiveAt, note: form.note.trim() || null, confirmed: true },
            } : mode === "update" && selected ? {
                method: "patch" as const,
                url: `/loans/${loanPublicId}/commission-participants/${selected.publicId}`,
                body: { commissionRate: form.commissionRate, role: form.role.trim(), effectiveFrom: effectiveAt, note: form.note.trim() || null, confirmed: true },
            } : mode === "end" && selected ? {
                method: "post" as const,
                url: `/loans/${loanPublicId}/commission-participants/${selected.publicId}/end`,
                body: { effectiveTo: effectiveAt, reason: form.note.trim(), confirmed: true },
            } : null;
            if (!command) return;
            const fingerprint = JSON.stringify(command);
            if (commandIntentRef.current?.fingerprint !== fingerprint) {
                commandIntentRef.current = { fingerprint, idempotencyKey: crypto.randomUUID() };
            }
            const headers = { "Idempotency-Key": commandIntentRef.current.idempotencyKey };
            if (command.method === "patch") await api.patch(command.url, command.body, { headers });
            else await api.post(command.url, command.body, { headers });
            if (await load()) {
                commandIntentRef.current = null;
                setMode(null);
            }
        } catch (saveError) {
            setError(domainMessage(saveError, t("loanDetail.agents.errors.save", "Unable to save the agent agreement.")));
        } finally { setSaving(false); }
    };

    return (
        <Card>
            <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div><CardTitle>{t("loanDetail.agents.title", "Agents")}</CardTitle><p className="mt-1 text-sm text-muted-foreground">{t("loanDetail.agents.description", "Effective-dated agent commission agreements for this loan.")}</p></div>
                <Button onClick={() => open("add")}><Plus className="mr-2 h-4 w-4" />{t("loanDetail.agents.add", "Add agent")}</Button>
            </CardHeader>
            <CardContent>
                {error && !mode && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
                {loading ? <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading", "Loading...")}</div>
                    : participants.length === 0 ? <div className="rounded border border-dashed p-5 text-sm text-muted-foreground">{t("loanDetail.agents.empty", "No agents assigned")}</div>
                    : <div className="overflow-x-auto"><Table className="min-w-[52rem]"><TableHeader><TableRow>
                        <TableHead>{t("loanDetail.agents.agent", "Agent")}</TableHead><TableHead>{t("loanDetail.agents.role", "Role")}</TableHead><TableHead className="text-right">{t("loanDetail.agents.rate", "Commission rate")}</TableHead><TableHead>{t("loanDetail.agents.effective", "Effective dates")}</TableHead><TableHead>{t("common.status", "Status")}</TableHead><TableHead><span className="sr-only">{t("common.actions", "Actions")}</span></TableHead>
                    </TableRow></TableHeader><TableBody>
                        {participants.map((participant) => { const intermediary = intermediaryById.get(participant.intermediaryPublicId); return <TableRow key={participant.publicId}>
                            <TableCell><div className="font-medium">{participant.intermediaryName ?? intermediary?.name ?? participant.intermediaryPublicId}</div>{(participant.intermediaryAliases ?? intermediary?.aliases)?.length ? <div className="text-xs text-muted-foreground">{(participant.intermediaryAliases ?? intermediary?.aliases)?.join(", ")}</div> : null}</TableCell>
                            <TableCell>{participant.role}</TableCell><TableCell className="text-right font-medium tabular-nums">{participant.commissionRate}%</TableCell><TableCell className="whitespace-nowrap text-sm">{formatDate(participant.effectiveFrom)} – {formatDate(participant.effectiveTo)}</TableCell><TableCell><Badge variant={participant.status === "active" ? "default" : "outline"}>{t(`loanDetail.agents.status.${participant.status}`, participant.status)}</Badge></TableCell>
                            <TableCell className="text-right">{participant.status === "active" && <div className="flex justify-end gap-1"><Button size="sm" variant="outline" onClick={() => open("update", participant)} aria-label={t("loanDetail.agents.update", "Update agent")}><Pencil className="h-4 w-4" /></Button><Button size="sm" variant="outline" onClick={() => open("end", participant)} aria-label={t("loanDetail.agents.end", "End agent")}><XCircle className="h-4 w-4" /></Button></div>}</TableCell>
                        </TableRow>; })}
                        <TableRow><TableCell colSpan={2} className="font-semibold">{t("loanDetail.agents.total", "Active total")}</TableCell><TableCell className="text-right font-semibold tabular-nums">{totalRate}%</TableCell><TableCell colSpan={3} /></TableRow>
                    </TableBody></Table></div>}
            </CardContent>
            <Dialog open={mode !== null} onOpenChange={(isOpen) => !saving && !isOpen && setMode(null)}><DialogContent><DialogHeader><DialogTitle>{t(`loanDetail.agents.dialog.${mode ?? "add"}.title`, mode === "update" ? "Update agent" : mode === "end" ? "End agent" : "Add agent")}</DialogTitle><DialogDescription>{t("loanDetail.agents.dialog.description", "Changes create an effective-dated participant version and require confirmation.")}</DialogDescription></DialogHeader>
                <div className="space-y-4">
                    {mode === "add" && <div className="grid gap-2"><label htmlFor="agent-intermediary">{t("loanDetail.agents.agent", "Agent")}</label><select id="agent-intermediary" className="h-10 rounded-md border bg-background px-3" value={form.intermediaryPublicId} onChange={(event) => setForm({ ...form, intermediaryPublicId: event.target.value, confirmed: false })}><option value="">{t("loanDetail.agents.choose", "Choose an agent")}</option>{intermediaries.map((item) => <option key={item.publicId} value={item.publicId}>{item.name}</option>)}</select></div>}
                    {mode !== "end" && <><div className="grid gap-2"><label htmlFor="agent-rate">{t("loanDetail.agents.rateInput", "Commission rate (%)")}</label><Input id="agent-rate" inputMode="decimal" value={form.commissionRate} onChange={(event) => setForm({ ...form, commissionRate: event.target.value, confirmed: false })} /></div><div className="grid gap-2"><label htmlFor="agent-role">{t("loanDetail.agents.role", "Role")}</label><Input id="agent-role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value, confirmed: false })} /></div></>}
                    <div className="grid gap-2"><label htmlFor="agent-effective">{t(mode === "end" ? "loanDetail.agents.effectiveTo" : "loanDetail.agents.effectiveFrom", mode === "end" ? "Effective to" : "Effective from")}</label><Input id="agent-effective" type="datetime-local" value={form.effectiveAt} onChange={(event) => setForm({ ...form, effectiveAt: event.target.value, confirmed: false })} /></div>
                    <div className="grid gap-2"><label htmlFor="agent-note">{t(mode === "end" ? "loanDetail.agents.reason" : "loanDetail.agents.note", mode === "end" ? "Reason" : "Note")}</label><Input id="agent-note" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value, confirmed: false })} /></div>
                    <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={form.confirmed} onChange={(event) => setForm({ ...form, confirmed: event.target.checked })} /><span>{t("loanDetail.agents.confirmation", "I confirm this commission agreement")}</span></label>
                    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                </div><DialogFooter><Button variant="outline" disabled={saving} onClick={() => setMode(null)}>{t("common.cancel", "Cancel")}</Button><Button disabled={saving} onClick={() => void submit()}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t(`loanDetail.agents.dialog.${mode ?? "add"}.confirm`, mode === "update" ? "Confirm update" : mode === "end" ? "Confirm end" : "Confirm add")}</Button></DialogFooter>
            </DialogContent></Dialog>
        </Card>
    );
}
