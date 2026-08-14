import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { Plus, Search, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";

type IntermediarySummary = {
    publicId: string;
    name: string;
    aliases: string[];
    status: string;
};

export default function IntermediaryList() {
    const { t } = useTranslation();
    const [items, setItems] = useState<IntermediarySummary[]>([]);
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [loading, setLoading] = useState(true);

    async function load(search = "") {
        setLoading(true);
        try {
            const response = await api.get<IntermediarySummary[]>("/intermediaries", search ? { params: { q: search } } : undefined);
            setItems(response.data);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        let active = true;
        void api.get<IntermediarySummary[]>("/intermediaries").then((response) => {
            if (active) setItems(response.data);
        }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, []);

    async function submitSearch(event: FormEvent) {
        event.preventDefault();
        await load(query.trim());
    }

    async function createProfile(event: FormEvent) {
        event.preventDefault();
        const trimmedName = name.trim();
        if (!trimmedName) return;
        const response = await api.post<IntermediarySummary>("/intermediaries", { name: trimmedName });
        setItems((current) => [response.data, ...current.filter((item) => item.publicId !== response.data.publicId)]);
        setName("");
        setCreating(false);
    }

    return <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
                <h1 className="text-2xl font-bold">{t("intermediary.directory.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("intermediary.directory.subtitle")}</p>
            </div>
            <Button onClick={() => setCreating((current) => !current)}><Plus className="mr-2 h-4 w-4" />{t("intermediary.directory.new")}</Button>
        </div>

        {creating && <form className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-end" onSubmit={createProfile}>
            <label className="flex-1 text-sm font-medium">{t("intermediary.directory.name")}
                <Input className="mt-1" value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <Button type="submit">{t("intermediary.directory.create")}</Button>
        </form>}

        <form className="flex max-w-lg gap-2" role="search" onSubmit={submitSearch}>
            <Input type="search" aria-label={t("intermediary.directory.searchLabel")} placeholder={t("intermediary.directory.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
            <Button type="submit" variant="outline"><Search className="mr-2 h-4 w-4" />{t("intermediary.directory.search")}</Button>
        </form>

        {loading ? <p>{t("common.loading")}</p> : items.length === 0 ? <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground"><Users className="mx-auto mb-3 h-10 w-10" />{t("intermediary.directory.empty")}</div> : <div className="divide-y rounded-lg border bg-card">
            {items.map((item) => <Link className="flex items-center justify-between gap-4 p-4 hover:bg-muted/50" key={item.publicId} to={`/intermediaries/${item.publicId}`}>
                <div><p className="font-semibold">{item.name}</p>{item.aliases.length > 0 && <p className="text-sm text-muted-foreground">{item.aliases.join(" · ")}</p>}</div>
                <span className="text-xs uppercase text-muted-foreground">{item.status}</span>
            </Link>)}
        </div>}
    </div>;
}
