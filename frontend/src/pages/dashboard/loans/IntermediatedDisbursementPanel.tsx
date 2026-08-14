import { useEffect, useRef, useState } from "react";
import Decimal from "decimal.js";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { EvidencePreviewButton } from "../../../components/evidence/EvidencePreviewButton";

type EvidenceItem = { publicId: string; filePublicId: string; status: string; mimeType: string | null };
export type IntermediatedTransferEvent = {
    publicId: string; role: "funding_to_intermediary" | "borrower_net_payout" | "advance_interest_return";
    channel: string; amount: string; senderHint: string | null; payeeHint: string | null;
    bankReference: string | null; transferredAt: string; status: string;
    evidence: { status: string; count: number; items: EvidenceItem[] };
};
export type IntermediatedDisbursementGroup = {
    publicId: string; loanPublicId: string; intermediaryPublicId: string; status: string;
    retainedBalance: string; events: IntermediatedTransferEvent[];
    latestPreview?: { publicId: string; previewHash: string; status: string; variance: string; evidenceReady: boolean; warnings: string[]; expiresAt: string } | null;
};

const ROLE_KEYS = {
    funding_to_intermediary: "fundingToIntermediary",
    borrower_net_payout: "borrowerNetPayout",
    advance_interest_return: "advanceInterestReturn",
} as const;

export function TransferGroupView({ group, onPosted }: { group: IntermediatedDisbursementGroup; onPosted?: (group: IntermediatedDisbursementGroup) => Promise<void> }) {
    const { t, i18n } = useTranslation();
    const readyItems = group.events.flatMap((event) => event.evidence.items
        .filter((item) => item.status === "ready")
        .map((item) => ({ event, item })));
    const suppliedEvidenceReady = group.events.every((event) => event.evidence.items.every((item) => item.status === "ready"));
    const sourceProposalIdentity = group.latestPreview ? `${group.latestPreview.publicId}:${group.latestPreview.previewHash}` : "none";
    const [refreshed, setRefreshed] = useState<{ sourceProposalIdentity: string; preview: NonNullable<IntermediatedDisbursementGroup["latestPreview"]> } | null>(null);
    const preview = refreshed?.sourceProposalIdentity === sourceProposalIdentity ? refreshed.preview : group.latestPreview ?? null;
    const proposalIdentity = preview ? `${preview.publicId}:${preview.previewHash}` : null;
    const [confirmedProposalIdentity, setConfirmedProposalIdentity] = useState<string | null>(null);
    const [posting, setPosting] = useState(false);
    const [postFailedIdentity, setPostFailedIdentity] = useState<string | null>(null);
    const [changedProposalIdentity, setChangedProposalIdentity] = useState<string | null>(null);
    const [posted, setPosted] = useState(group.status === "posted");
    const [refreshFailed, setRefreshFailed] = useState(false);
    const [authoritativeGroup, setAuthoritativeGroup] = useState<IntermediatedDisbursementGroup | null>(null);
    const postIntent = useRef<{ proposalPublicId: string; key: string } | null>(null);
    const confirmed = proposalIdentity !== null && confirmedProposalIdentity === proposalIdentity;
    const [initialNow] = useState(() => Date.now());
    const [expiredProposalIdentity, setExpiredProposalIdentity] = useState<string | null>(null);
    useEffect(() => {
        if (!preview) return;
        const remaining = Date.parse(preview.expiresAt) - Date.now();
        const timer = window.setTimeout(() => setExpiredProposalIdentity(proposalIdentity), Math.max(0, Math.min(remaining + 1, 2_147_483_647)));
        return () => window.clearTimeout(timer);
    }, [preview, proposalIdentity]);
    const expired = Boolean(preview && (expiredProposalIdentity === proposalIdentity || Date.parse(preview.expiresAt) <= initialNow));
    const confirmable = Boolean(preview && preview.status === "ready" && preview.evidenceReady
        && !expired
        && new Decimal(preview.variance).isZero() && suppliedEvidenceReady);
    const date = (value: string) => new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok",
    }).format(new Date(value));

    return <article className="space-y-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold">{t("intermediatedDisbursement.group")}</span>
            <span className="rounded-full border px-2 py-0.5 text-xs">{t(`intermediatedDisbursement.status.${authoritativeGroup?.status ?? group.status}`, { defaultValue: authoritativeGroup?.status ?? group.status })}</span>
        </div>
        <div className="space-y-3">
            {group.events.map((event) => <div className="rounded-md border p-3" key={event.publicId}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div><p className="font-medium">{t(`intermediatedDisbursement.roles.${ROLE_KEYS[event.role]}`)}</p><p className="text-xs text-muted-foreground">{t(`intermediatedDisbursement.channel.${event.channel}`, { defaultValue: event.channel })}</p></div>
                    <p className="font-semibold">{formatMoneyExact(event.amount, i18n.language)}</p>
                </div>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div><dt className="text-xs text-muted-foreground">{t("intermediatedDisbursement.sender")}</dt><dd>{event.senderHint || "—"}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t("intermediatedDisbursement.payee")}</dt><dd>{event.payeeHint || "—"}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t("intermediatedDisbursement.date")}</dt><dd>{date(event.transferredAt)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t("intermediatedDisbursement.reference")}</dt><dd>{event.bankReference || "—"}</dd></div>
                </dl>
                <p className="mt-2 text-xs text-muted-foreground">{t("common.status")}: {t(`intermediatedDisbursement.status.${event.status}`, { defaultValue: event.status })}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                    {readyItems.filter(({ event: owner }) => owner.publicId === event.publicId).map(({ item }) => {
                        const slipNumber = readyItems.findIndex(({ item: candidate }) => candidate.publicId === item.publicId) + 1;
                        const label = t("intermediatedDisbursement.viewSlip", { number: slipNumber });
                        return <EvidencePreviewButton key={item.publicId} available label={label} mimeType={item.mimeType} resolve={async () => {
                            const response = await api.get(`/intermediated-disbursements/${group.publicId}/events/${event.publicId}/evidence/${item.publicId}/access`);
                            return response.data;
                        }} />;
                    })}
                </div>
            </div>)}
        </div>
        <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmedProposalIdentity(event.target.checked ? proposalIdentity : null)} disabled={!confirmable || posting || posted} />
            <span>{t("intermediatedDisbursement.confirmReady")}</span>
        </label>
        {!confirmable && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{t(expired ? "intermediatedDisbursement.expired" : "intermediatedDisbursement.confirmBlocked")}</p>}
        {expired && <button className="rounded-md border px-3 py-2 text-sm font-medium" type="button" disabled={posting} onClick={() => {
            setPosting(true); setPostFailedIdentity(null);
            void api.post(`/intermediated-disbursements/${group.publicId}/preview`, {}).then((response) => {
                const nextPreview = response.data as NonNullable<IntermediatedDisbursementGroup["latestPreview"]>;
                setRefreshed({ sourceProposalIdentity, preview: nextPreview });
                setConfirmedProposalIdentity(null); setChangedProposalIdentity(`${nextPreview.publicId}:${nextPreview.previewHash}`); postIntent.current = null;
            }).catch(() => setPostFailedIdentity(proposalIdentity)).finally(() => setPosting(false));
        }}>{t("intermediatedDisbursement.refreshProposal")}</button>}
        {changedProposalIdentity === proposalIdentity && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{t("intermediatedDisbursement.proposalChanged")}</p>}
        {postFailedIdentity === proposalIdentity && <p role="alert" className="text-sm text-destructive">{t("intermediatedDisbursement.postError")}</p>}
        {refreshFailed && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{t("intermediatedDisbursement.refreshFailed")}</p>}
        <button className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50" type="button" disabled={!confirmable || !confirmed || posting || posted} onClick={() => {
            if (!preview) return;
            setPosting(true); setPostFailedIdentity(null); setChangedProposalIdentity(null);
            if (postIntent.current?.proposalPublicId !== preview.publicId) {
                postIntent.current = { proposalPublicId: preview.publicId, key: crypto.randomUUID() };
            }
            const run = async () => {
                try {
                    await api.post(`/intermediated-disbursements/${group.publicId}/post`, { proposalPublicId: preview.publicId, confirmed: true }, {
                        headers: { "Idempotency-Key": postIntent.current!.key },
                    });
                    try {
                        const detail = (await api.get(`/intermediated-disbursements/${group.publicId}`)).data as IntermediatedDisbursementGroup;
                        if (onPosted) await onPosted(detail);
                        setAuthoritativeGroup(detail); setPosted(true); setConfirmedProposalIdentity(null);
                    } catch {
                        setRefreshFailed(true);
                    }
                } catch (error) {
                    const code = (error as { response?: { data?: { code?: string } } }).response?.data?.code;
                    if (code === "STALE_INTERMEDIATED_DISBURSEMENT_PROPOSAL") {
                        try {
                            const response = await api.post(`/intermediated-disbursements/${group.publicId}/preview`, {});
                            const nextPreview = response.data as NonNullable<IntermediatedDisbursementGroup["latestPreview"]>;
                            setRefreshed({ sourceProposalIdentity, preview: nextPreview });
                            setConfirmedProposalIdentity(null);
                            setChangedProposalIdentity(`${nextPreview.publicId}:${nextPreview.previewHash}`);
                            postIntent.current = null;
                        } catch {
                            setPostFailedIdentity(proposalIdentity);
                        }
                    } else {
                        setPostFailedIdentity(proposalIdentity);
                    }
                } finally {
                    setPosting(false);
                }
            };
            void run();
        }}>{posted ? t("intermediatedDisbursement.posted") : t("intermediatedDisbursement.postConfirmed")}</button>
    </article>;
}

export function IntermediatedDisbursementPanel({ loanPublicId, onPosted }: { loanPublicId: string; onPosted?: (group: IntermediatedDisbursementGroup) => Promise<void> }) {
    const { t } = useTranslation();
    const [result, setResult] = useState<{ scope: string; groups: IntermediatedDisbursementGroup[]; failed: boolean } | null>(null);
    useEffect(() => {
        let active = true;
        void api.get("/intermediated-disbursements", { params: { loanPublicId } }).then(async (response) => {
            const summaries = (response.data ?? []) as IntermediatedDisbursementGroup[];
            return Promise.all(summaries.map(async (group) => (await api.get(`/intermediated-disbursements/${group.publicId}`)).data));
        }).then((details) => {
            if (active) setResult({ scope: loanPublicId, groups: details, failed: false });
        }).catch(() => { if (active) setResult({ scope: loanPublicId, groups: [], failed: true }); });
        return () => { active = false; };
    }, [loanPublicId]);
    const scopeLoading = result?.scope !== loanPublicId;
    const groups = scopeLoading ? [] : result.groups;
    const failed = !scopeLoading && result.failed;
    return <section aria-label={t("intermediatedDisbursement.panelTitle")} className="space-y-3">
        <h2 className="text-lg font-semibold">{t("intermediatedDisbursement.panelTitle")}</h2>
        {scopeLoading ? <p>{t("common.loading")}</p> : failed ? <p role="alert">{t("intermediatedDisbursement.loadError")}</p> : groups.length ? groups.map((group) => <TransferGroupView group={group} key={group.publicId} onPosted={async (detail) => {
            if (onPosted) await onPosted(detail);
            setResult((current) => current?.scope === loanPublicId ? { ...current, groups: current.groups.map((item) => item.publicId === detail.publicId ? detail : item) } : current);
        }} />) : <p className="rounded border border-dashed p-4 text-sm text-muted-foreground">{t("intermediatedDisbursement.empty")}</p>}
    </section>;
}
