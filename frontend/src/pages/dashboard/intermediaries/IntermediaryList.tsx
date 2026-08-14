import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { Plus, Search, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";

type IntermediarySummary = { publicId: string; name: string; aliases: string[]; status: string };
type ErrorKind = "load" | "search" | "candidate" | "create" | null;

const aliasesFrom = (value: string) => [...new Set(value.split(",").map((alias) => alias.trim()).filter(Boolean))];
const identityKey = (name: string, aliases: string[]) => JSON.stringify([name.trim(), ...aliases]);

export default function IntermediaryList() {
    const { t } = useTranslation();
    const [items, setItems] = useState<IntermediarySummary[]>([]);
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [aliasesText, setAliasesText] = useState("");
    const [candidateKey, setCandidateKey] = useState<string | null>(null);
    const [candidates, setCandidates] = useState<IntermediarySummary[]>([]);
    const [reviewed, setReviewed] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorKind>(null);
    const aliases = useMemo(() => aliasesFrom(aliasesText), [aliasesText]);
    const currentIdentityKey = identityKey(name, aliases);
    const creationEnabled = Boolean(name.trim() && candidateKey === currentIdentityKey && reviewed && !busy);

    async function load(search = "", kind: ErrorKind = "search") {
        setLoading(true);
        setError(null);
        try {
            const response = await api.get<IntermediarySummary[]>("/intermediaries", search ? { params: { q: search } } : undefined);
            setItems(response.data);
        } catch {
            setError(kind);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        let active = true;
        void api.get<IntermediarySummary[]>("/intermediaries").then((response) => {
            if (active) setItems(response.data);
        }).catch(() => { if (active) setError("load"); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, []);

    function changeIdentity(update: () => void) {
        update();
        setCandidateKey(null);
        setCandidates([]);
        setReviewed(false);
        setError(null);
    }

    async function submitSearch(event: FormEvent) {
        event.preventDefault();
        await load(query.trim());
    }

    async function searchCandidates() {
        const proposedName = name.trim();
        if (!proposedName || busy) return;
        setBusy(true);
        setError(null);
        setReviewed(false);
        try {
            const responses = await Promise.all([proposedName, ...aliases].map((identity) => api.get<IntermediarySummary[]>("/intermediaries", { params: { q: identity, status: "all" } })));
            const unique = new Map(responses.flatMap((response) => response.data).map((candidate) => [candidate.publicId, candidate]));
            setCandidates([...unique.values()]);
            setCandidateKey(identityKey(proposedName, aliases));
        } catch {
            setCandidateKey(null);
            setCandidates([]);
            setError("candidate");
        } finally {
            setBusy(false);
        }
    }

    async function createProfile(event: FormEvent) {
        event.preventDefault();
        if (!creationEnabled) return;
        setBusy(true);
        setError(null);
        try {
            const response = await api.post<IntermediarySummary>("/intermediaries", { name: name.trim(), ...(aliases.length ? { aliases } : {}) });
            setItems((current) => [response.data, ...current.filter((item) => item.publicId !== response.data.publicId)]);
            setName(""); setAliasesText(""); setCreating(false); setCandidateKey(null); setCandidates([]); setReviewed(false);
        } catch {
            setError("create");
        } finally {
            setBusy(false);
        }
    }

    return <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">{t("intermediary.directory.title")}</h1><p className="text-sm text-muted-foreground">{t("intermediary.directory.subtitle")}</p></div>
            <Button onClick={() => { setCreating((current) => !current); setError(null); }}><Plus className="mr-2 h-4 w-4" />{t("intermediary.directory.new")}</Button></div>

        {creating && <form className="space-y-3 rounded-lg border bg-card p-4" onSubmit={createProfile}>
            <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-medium">{t("intermediary.directory.name")}<Input className="mt-1" value={name} onChange={(event) => changeIdentity(() => setName(event.target.value))} required /></label>
                <label className="text-sm font-medium">{t("intermediary.directory.aliases")}<Input className="mt-1" value={aliasesText} onChange={(event) => changeIdentity(() => setAliasesText(event.target.value))} placeholder={t("intermediary.directory.aliasesHint")} /></label></div>
            <Button type="button" variant="outline" disabled={!name.trim() || busy} onClick={() => void searchCandidates()}>{t("intermediary.directory.searchIdentity")}</Button>
            {candidateKey === currentIdentityKey && <div className="rounded-md border p-3"><p className="text-sm font-medium">{t("intermediary.directory.candidates", { count: candidates.length })}</p>{candidates.map((candidate) => <Link className="mt-2 flex items-center justify-between gap-3 text-sm underline" key={candidate.publicId} to={`/intermediaries/${candidate.publicId}`}><span>{candidate.name}</span><span className="text-xs uppercase no-underline text-muted-foreground">{t(`intermediary.directory.status.${candidate.status}`)}</span></Link>)}
                <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />{t("intermediary.directory.reviewedCandidates")}</label></div>}
            {error === "candidate" && <p role="alert" className="text-sm text-destructive">{t("intermediary.directory.errors.candidate")}</p>}
            {error === "create" && <p role="alert" className="text-sm text-destructive">{t("intermediary.directory.errors.create")}</p>}
            <Button type="submit" disabled={!creationEnabled}>{t("intermediary.directory.create")}</Button>
        </form>}

        <form className="flex max-w-lg gap-2" role="search" onSubmit={submitSearch}><Input type="search" aria-label={t("intermediary.directory.searchLabel")} placeholder={t("intermediary.directory.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} /><Button type="submit" variant="outline"><Search className="mr-2 h-4 w-4" />{t("intermediary.directory.search")}</Button></form>
        {(error === "load" || error === "search") && <div role="alert" className="rounded-md border border-destructive/40 p-4 text-sm text-destructive"><p>{t(`intermediary.directory.errors.${error}`)}</p><Button className="mt-3" size="sm" variant="outline" onClick={() => void load(query.trim(), query.trim() ? "search" : "load")}>{t("common.retry")}</Button></div>}
        {loading ? <p>{t("common.loading")}</p> : !error && (items.length === 0 ? <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground"><Users className="mx-auto mb-3 h-10 w-10" />{t("intermediary.directory.empty")}</div> : <div className="divide-y rounded-lg border bg-card">{items.map((item) => <Link className="flex items-center justify-between gap-4 p-4 hover:bg-muted/50" key={item.publicId} to={`/intermediaries/${item.publicId}`}><div><p className="font-semibold">{item.name}</p>{item.aliases.length > 0 && <p className="text-sm text-muted-foreground">{item.aliases.join(" · ")}</p>}</div><span className="text-xs uppercase text-muted-foreground">{t(`intermediary.directory.status.${item.status}`)}</span></Link>)}</div>)}
    </div>;
}
