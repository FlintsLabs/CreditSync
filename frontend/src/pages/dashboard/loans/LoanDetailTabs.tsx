import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export type LoanDetailTab = "information" | "agents" | "payments" | "schedule";

const tabs: LoanDetailTab[] = ["information", "agents", "payments", "schedule"];

interface LoanDetailTabsProps {
    value: LoanDetailTab;
    onChange: (tab: LoanDetailTab) => void;
    renderPanel: (tab: LoanDetailTab) => ReactNode;
}

export function LoanDetailTabs({ value, onChange, renderPanel }: LoanDetailTabsProps) {
    const { t } = useTranslation();
    const moveFocus = (tab: LoanDetailTab, direction: 1 | -1) => {
        const currentIndex = tabs.indexOf(tab);
        const next = tabs[(currentIndex + direction + tabs.length) % tabs.length];
        onChange(next);
        window.requestAnimationFrame(() => document.getElementById(`loan-detail-tab-${next}`)?.focus());
    };
    return (
        <div className="space-y-6">
            <div className="overflow-x-auto">
                <div className="inline-flex min-w-max rounded-lg border bg-muted/30 p-1" role="tablist" aria-label={t("loanDetail.tabs.label", "Loan detail sections")}>
                    {tabs.map((tab) => (
                        <button
                            key={tab}
                            id={`loan-detail-tab-${tab}`}
                            type="button"
                            role="tab"
                            aria-selected={value === tab}
                            aria-controls={`loan-detail-panel-${tab}`}
                            tabIndex={value === tab ? 0 : -1}
                            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${value === tab ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                            onClick={() => onChange(tab)}
                            onKeyDown={(event) => {
                                if (event.key === "ArrowRight") { event.preventDefault(); moveFocus(tab, 1); }
                                if (event.key === "ArrowLeft") { event.preventDefault(); moveFocus(tab, -1); }
                                if (event.key === "Home") { event.preventDefault(); onChange(tabs[0]); }
                                if (event.key === "End") { event.preventDefault(); onChange(tabs[tabs.length - 1]); }
                            }}
                        >
                            {t(`loanDetail.tabs.${tab}`, tab === "information" ? "Information" : tab === "agents" ? "Agents" : tab === "payments" ? "Payment History" : "Repayment Schedule")}
                        </button>
                    ))}
                </div>
            </div>
            <div id={`loan-detail-panel-${value}`} role="tabpanel" aria-labelledby={`loan-detail-tab-${value}`} tabIndex={0}>
                {renderPanel(value)}
            </div>
        </div>
    );
}
