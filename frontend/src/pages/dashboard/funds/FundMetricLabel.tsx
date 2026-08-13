import { useState } from "react";
import { Info, type LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";

interface FundMetricLabelProps {
    icon: LucideIcon;
    label: string;
    description: string;
    infoLabel: string;
}

export function FundMetricLabel({ icon: Icon, label, description, infoLabel }: FundMetricLabelProps) {
    const [open, setOpen] = useState(false);

    return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            <Icon data-fund-metric-icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span>{label}</span>
            <Tooltip open={open} onOpenChange={setOpen}>
                <TooltipTrigger asChild>
                    <button
                        type="button"
                        aria-label={infoLabel}
                        onClick={() => setOpen(true)}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <Info aria-hidden="true" className="h-4 w-4" />
                    </button>
                </TooltipTrigger>
                <TooltipContent>{description}</TooltipContent>
            </Tooltip>
        </span>
    );
}
