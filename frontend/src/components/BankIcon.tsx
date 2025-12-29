import { Building2 } from "lucide-react";
import { cn } from "../lib/utils";

type BankCode = 'kbank' | 'scb' | 'bbl' | 'ktb' | 'bay' | 'ttb' | 'gsb' | 'uob' | 'citi';

interface BankConfig {
    color: string;
    label: string;
    textColor?: string;
}

const BANKS: Record<BankCode, BankConfig> = {
    kbank: { color: "#138f2d", label: "K" }, // Kasikorn - Green
    scb: { color: "#4e2576", label: "SCB" }, // Siam Commercial - Purple
    bbl: { color: "#1e4598", label: "BBL" }, // Bangkok Bank - Dark Blue
    ktb: { color: "#1ba5e1", label: "KTB" }, // Krungthai - Light Blue
    bay: { color: "#fec43b", label: "BAY", textColor: "black" }, // Krungsri - Yellow
    ttb: { color: "#0056ff", label: "ttb" }, // TMBThanachart - Blue
    gsb: { color: "#eb198d", label: "GSB" }, // Government Savings - Pink
    uob: { color: "#0b3156", label: "UOB" },
    citi: { color: "#003b70", label: "Citi" },
};

export function BankIcon({ name, className }: { name: string, className?: string }) {
    // Simple naive matching
    const lowerName = name.toLowerCase();

    let matchedBank: BankCode | null = null;
    if (lowerName.includes("kbank") || lowerName.includes("kasikorn") || lowerName.includes("กสิกร")) matchedBank = 'kbank';
    else if (lowerName.includes("scb") || lowerName.includes("siam commercial") || lowerName.includes("ไทยพาณิชย์")) matchedBank = 'scb';
    else if (lowerName.includes("bbl") || lowerName.includes("bangkok") || lowerName.includes("กรุงเทพ")) matchedBank = 'bbl';
    else if (lowerName.includes("ktb") || lowerName.includes("krungthai") || lowerName.includes("กรุงไทย")) matchedBank = 'ktb';
    else if (lowerName.includes("bay") || lowerName.includes("krungsri") || lowerName.includes("กรุงศรี")) matchedBank = 'bay';
    else if (lowerName.includes("ttb") || lowerName.includes("tmb") || lowerName.includes("thanachart") || lowerName.includes("ทีทีบี")) matchedBank = 'ttb';
    else if (lowerName.includes("gsb") || lowerName.includes("government savings") || lowerName.includes("ออมสิน")) matchedBank = 'gsb';
    else if (lowerName.includes("uob") || lowerName.includes("ยูโอบี")) matchedBank = 'uob';
    else if (lowerName.includes("citi") || lowerName.includes("ซิตี้")) matchedBank = 'citi';

    if (matchedBank) {
        const config = BANKS[matchedBank];
        return (
            <div
                className={cn("flex items-center justify-center rounded-lg shadow-sm font-bold border border-white/10", className)}
                style={{
                    backgroundColor: config.color,
                    color: config.textColor || "white"
                }}
            >
                {config.label}
            </div>
        );
    }

    // Default Fallback
    return (
        <div className={cn("flex items-center justify-center rounded-lg bg-muted text-muted-foreground", className)}>
            <Building2 className="h-1/2 w-1/2" />
        </div>
    );
}
