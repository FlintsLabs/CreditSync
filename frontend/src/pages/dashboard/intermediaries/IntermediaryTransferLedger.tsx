import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { TransferGroupView, type IntermediatedDisbursementGroup } from "../loans/IntermediatedDisbursementPanel";

export function IntermediaryTransferLedger({ intermediaryPublicId, onPosted }: { intermediaryPublicId: string; onPosted?: (group: IntermediatedDisbursementGroup) => Promise<void> }) {
    const { t } = useTranslation();
    const [result, setResult] = useState<{ scope: string; groups: IntermediatedDisbursementGroup[]; failed: boolean } | null>(null);
    useEffect(() => {
        let active = true;
        void api.get("/intermediated-disbursements", { params: { intermediaryPublicId } }).then(async (response) => {
            const summaries = (response.data ?? []) as IntermediatedDisbursementGroup[];
            return Promise.all(summaries.map(async (group) => (await api.get(`/intermediated-disbursements/${group.publicId}`)).data));
        }).then((details) => {
            if (active) setResult({ scope: intermediaryPublicId, groups: details, failed: false });
        }).catch(() => { if (active) setResult({ scope: intermediaryPublicId, groups: [], failed: true }); });
        return () => { active = false; };
    }, [intermediaryPublicId]);
    const scopeLoading = result?.scope !== intermediaryPublicId;
    const groups = scopeLoading ? [] : result.groups;
    const failed = !scopeLoading && result.failed;
    return <section aria-label={t("intermediatedDisbursement.ledgerTitle")} className="space-y-3">
        <h2 className="text-lg font-semibold">{t("intermediatedDisbursement.ledgerTitle")}</h2>
        {scopeLoading ? <p>{t("common.loading")}</p> : failed ? <p role="alert">{t("intermediatedDisbursement.loadError")}</p> : groups.map((group) => <div className="space-y-2" key={group.publicId}>
            <Link className="inline-flex text-sm font-medium text-primary hover:underline" to={`/loans/${group.loanPublicId}`}>{t("intermediatedDisbursement.openLoan")}</Link>
            <TransferGroupView group={group} onPosted={async (detail) => {
                if (onPosted) await onPosted(detail);
                setResult((current) => current?.scope === intermediaryPublicId ? { ...current, groups: current.groups.map((item) => item.publicId === detail.publicId ? detail : item) } : current);
            }} />
        </div>)}
        {!scopeLoading && !failed && groups.length === 0 && <p className="rounded border border-dashed p-4 text-sm text-muted-foreground">{t("intermediatedDisbursement.empty")}</p>}
    </section>;
}
