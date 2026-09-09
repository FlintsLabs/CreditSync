import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { formatMoneyExact } from "../../../lib/workflow-model";

type Intermediary = { publicId: string; name: string };
type Collection = { publicId: string; amount: string; borrowerPaidAt: string; status: string; linkedPaymentIntake: boolean };
type Remittance = { publicId: string; grossAmount: string; selectedTotal: string; remainingBalance: string; receivedAt: string; status: string; bankReference: string | null };

export default function IntermediaryRemittances() {
  const { t, i18n } = useTranslation();
  const [searchParams] = useSearchParams();
  const [intermediaries, setIntermediaries] = useState<Intermediary[]>([]);
  const [selected, setSelected] = useState(searchParams.get("intermediaryPublicId") ?? "");
  const [collections, setCollections] = useState<Collection[]>([]);
  const [remittances, setRemittances] = useState<Remittance[]>([]);
  const [loading, setLoading] = useState(true);
  const formatMoney = (value: string) => formatMoneyExact(value, i18n.language);
  const formatDate = (value: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value));

  const load = useCallback(async (intermediaryPublicId?: string) => {
    try {
      const params = intermediaryPublicId ? { intermediaryPublicId } : {};
      const [people, held, sent] = await Promise.all([
        api.get<Intermediary[]>("/intermediaries"),
        api.get<Collection[]>("/intermediary-collections", { params }),
        api.get<Remittance[]>("/intermediary-remittances", { params }),
      ]);
      setIntermediaries(people.data); setCollections(held.data); setRemittances(sent.data);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(selected || undefined); }, [load, selected]);

  return <div className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><Link className="text-sm text-muted-foreground hover:text-foreground" to="/intermediaries">← {t("intermediary.directory.title")}</Link><h1 className="text-2xl font-bold">{t("intermediary.title", "Intermediary remittances")}</h1><p className="text-sm text-muted-foreground">{t("intermediary.subtitle", "Track money collected from borrowers separately from money remitted to the lender.")}</p></div>
      <div className="flex gap-2"><select className="rounded-md border bg-background px-3 py-2 text-sm" value={selected} onChange={(event) => { setLoading(true); setSelected(event.target.value); }}><option value="">{t("intermediary.all", "All intermediaries")}</option>{intermediaries.map((person) => <option key={person.publicId} value={person.publicId}>{person.name}</option>)}</select><Button variant="outline" onClick={() => { setLoading(true); void load(selected || undefined); }}>{t("common.refresh", "Refresh")}</Button></div>
    </div>
    {loading ? <p>{t("common.loading", "Loading...")}</p> : <div className="grid gap-6 xl:grid-cols-2">
      <Card><CardHeader><CardTitle>{t("intermediary.held", "Borrower payments held")}</CardTitle></CardHeader><CardContent className="space-y-3">{collections.length === 0 ? <p className="text-sm text-muted-foreground">{t("intermediary.noHeld", "No held payments")}</p> : collections.map((item) => <div key={item.publicId} className="rounded-md border p-3"><div className="flex justify-between gap-3"><span className="font-semibold">{formatMoney(item.amount)}</span><span className="text-xs uppercase text-muted-foreground">{item.status}</span></div><p className="text-sm text-muted-foreground">{formatDate(item.borrowerPaidAt)} · {item.linkedPaymentIntake ? t("intermediary.linked", "linked to existing payment") : t("intermediary.unposted", "awaiting remittance posting")}</p></div>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>{t("intermediary.remitted", "Remittances received")}</CardTitle></CardHeader><CardContent className="space-y-3">{remittances.length === 0 ? <p className="text-sm text-muted-foreground">{t("intermediary.noRemittances", "No remittances")}</p> : remittances.map((item) => <div key={item.publicId} className="rounded-md border p-3"><div className="flex justify-between gap-3"><span className="font-semibold">{formatMoney(item.grossAmount)}</span><span className="text-xs uppercase text-muted-foreground">{item.status}</span></div><p className="text-sm text-muted-foreground">{formatDate(item.receivedAt)}{item.bankReference ? ` · ${item.bankReference}` : ""}</p><p className={item.remainingBalance === "0.00" ? "text-sm text-emerald-600" : "text-sm text-amber-600"}>{t("intermediary.balance", "Remaining balance")}: {formatMoney(item.remainingBalance)}</p></div>)}</CardContent></Card>
    </div>}
  </div>;
}
