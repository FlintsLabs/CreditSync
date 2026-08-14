import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { TransferGroupView, type IntermediatedDisbursementGroup } from "../loans/IntermediatedDisbursementPanel";

export function IntermediaryTransferLedger({ intermediaryPublicId }: { intermediaryPublicId: string }) {
    const { t } = useTranslation();
    const [groups, setGroups] = useState<IntermediatedDisbursementGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let active = true;
        void api.get("/intermediated-disbursements", { params: { intermediaryPublicId } }).then(async (response) => {
            const summaries = (response.data ?? []) as IntermediatedDisbursementGroup[];
            return Promise.all(summaries.map(async (group) => (await api.get(`/intermediated-disbursements/${group.publicId}`)).data));
        }).then((details) => {
            if (active) { setGroups(details); setFailed(false); }
        }).catch(() => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [intermediaryPublicId]);
    return <section aria-label={t("intermediatedDisbursement.ledgerTitle")} className="space-y-3">
        <h2 className="text-lg font-semibold">{t("intermediatedDisbursement.ledgerTitle")}</h2>
        {loading ? <p>{t("common.loading")}</p> : failed ? <p role="alert">{t("intermediatedDisbursement.loadError")}</p> : groups.map((group) => <div className="space-y-2" key={group.publicId}>
            <Link className="inline-flex text-sm font-medium text-primary hover:underline" to={`/loans/${group.loanPublicId}`}>{t("intermediatedDisbursement.openLoan")}</Link>
            <TransferGroupView group={group} />
        </div>)}
        {!loading && !failed && groups.length === 0 && <p className="rounded border border-dashed p-4 text-sm text-muted-foreground">{t("intermediatedDisbursement.empty")}</p>}
    </section>;
}
