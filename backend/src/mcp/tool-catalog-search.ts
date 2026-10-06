import { createHash } from "node:crypto";
import { TOOL_GUIDANCE, type ToolGuidance } from "./tool-guidance";
import { TOOL_PROFILES } from "./tool-profiles";
import type { McpToolDefinition, McpToolName, ToolProfile } from "./catalog-types";

export type ToolCatalogSearchInput = Readonly<{ query: string; limit?: number; cursor?: string; knownCatalogVersion?: string; knownGuidanceVersion?: string }>;
export type ToolCatalogSearchResult = Readonly<{
    profile: ToolProfile; catalogVersion: string; guidanceVersion: string;
    status: "matches" | "needs_clarification" | "no_match" | "connection_required" | "refresh_required";
    matches: readonly Readonly<{ toolName: McpToolName; purpose: string; domain: ToolGuidance["domain"]; whenToUse: readonly string[]; prerequisites: readonly string[]; sideEffects: readonly string[]; retrySafety: string; requiresHumanConfirmation: boolean; relatedTools: readonly McpToolName[] }>[];
    hasMore: boolean; nextCursor: string | null; requiredProfiles: readonly ToolProfile[];
}>;
type Context = Readonly<{ profile: ToolProfile; catalogVersion: string; guidanceVersion: string; catalog: readonly McpToolDefinition[] }>;
const phrases: readonly { phrase: string; names: readonly McpToolName[] }[] = [
    { phrase: "เปลี่ยนวันชำระงวดแรก", names: ["loan.payment-start-date.update"] }, { phrase: "แก้วันเริ่มชำระ", names: ["loan.payment-start-date.update"] },
    { phrase: "วันชำระงวดแรก", names: ["loan.payment-start-date.update"] }, { phrase: "เปลี่ยนวันเริ่มงวด", names: ["loan.payment-start-date.update"] },
    { phrase: "first payment date", names: ["loan.payment-start-date.update"] }, { phrase: "change first payment date", names: ["loan.payment-start-date.update"] },
    { phrase: "ค้นหาผู้กู้", names: ["borrower.search"] }, { phrase: "search borrower", names: ["borrower.search"] },
    { phrase: "แนบสลิปการชำระ", names: ["payment.evidence-supplement.import-chatgpt-file"] }, { phrase: "payment slip evidence", names: ["payment.evidence-supplement.import-chatgpt-file"] },
    { phrase: "payment evidence", names: ["payment.evidence-supplement.import-chatgpt-file"] }, { phrase: "หลักฐานรับชำระ", names: ["payment.evidence-supplement.import-chatgpt-file"] },
    { phrase: "หลักฐานการจ่ายเงินกู้", names: ["loan.disbursement.evidence.import-chatgpt-file"] }, { phrase: "loan payout evidence", names: ["loan.disbursement.evidence.import-chatgpt-file"] },
    { phrase: "payout evidence", names: ["loan.disbursement.evidence.import-chatgpt-file"] }, { phrase: "หลักฐานจ่ายเงินกู้", names: ["loan.disbursement.evidence.import-chatgpt-file"] },
    { phrase: "พรีวิวค่าคอมมิชชัน", names: ["loan.commission.preview"] }, { phrase: "commission preview", names: ["loan.commission.preview"] },
    { phrase: "กู้คืนรายการที่กลับรายการ", names: ["payment.restore.create", "payment.restore.preview", "payment.restore.execute"] }, { phrase: "restore reversed payment", names: ["payment.restore.create", "payment.restore.preview", "payment.restore.execute"] },
    { phrase: "แทนรายการที่ยกเลิก", names: ["payment.replacement.create", "payment.replacement.inspect"] }, { phrase: "replace cancelled payment", names: ["payment.replacement.create", "payment.replacement.inspect"] },
    { phrase: "cancelled payment replacement", names: ["payment.replacement.create", "payment.replacement.inspect"] },
    { phrase: "reversed payment restore", names: ["payment.restore.create", "payment.restore.preview", "payment.restore.execute"] },
    { phrase: "ยกเลิกสัญญากู้", names: ["loan.cancel.preview", "loan.cancel.execute"] },
    { phrase: "cancel loan", names: ["loan.cancel.preview", "loan.cancel.execute"] },
];
const generic = new Set(["tool", "catalog", "search", "find", "get", "show", "please", "can", "you", "the", "a", "to", "for", "ดู", "หา", "ขอ", "รายการ", "ข้อมูล", "ช่วย"]);
function normalize(text: string) { return text.normalize("NFKC").toLocaleLowerCase("th").replace(/[\p{P}\p{S}\s]+/gu, " ").trim().replace(/\s+/g, " "); }
function digest(text: string) { return createHash("sha256").update(text).digest("hex").slice(0, 20); }
function cursorEncode(value: object) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function cursorDecode(value: string): unknown { try { if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null; return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { return null; } }
export function searchToolCatalog(input: ToolCatalogSearchInput, context: Context): ToolCatalogSearchResult {
    const base = { profile: context.profile, catalogVersion: context.catalogVersion, guidanceVersion: context.guidanceVersion };
    if (typeof input.query !== "string" || input.query.trim().length < 1 || input.query.trim().length > 240 || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10))) throw new Error("Invalid catalog search input");
    const query = normalize(input.query);
    if ((input.knownCatalogVersion && input.knownCatalogVersion !== context.catalogVersion) || (input.knownGuidanceVersion && input.knownGuidanceVersion !== context.guidanceVersion)) return { ...base, status: "refresh_required", matches: [], hasMore: false, nextCursor: null, requiredProfiles: [] };
    const limit = input.limit ?? 5;
    let offset = 0;
    if (input.cursor !== undefined) {
        const decoded = cursorDecode(input.cursor) as { q?: unknown; p?: unknown; c?: unknown; g?: unknown; o?: unknown } | null;
        if (!decoded || Object.keys(decoded).sort().join(",") !== "c,g,o,p,q" || decoded.q !== digest(query) || decoded.p !== context.profile || decoded.c !== context.catalogVersion || decoded.g !== context.guidanceVersion || !Number.isSafeInteger(decoded.o) || (decoded.o as number) < 0 || (decoded.o as number) > 10000) return { ...base, status: "refresh_required", matches: [], hasMore: false, nextCursor: null, requiredProfiles: [] };
        offset = decoded.o as number;
    }
    const defs = new Map(context.catalog.map((d, i) => [d.name, { d, i }]));
    const active = new Set(TOOL_PROFILES[context.profile]);
    const scores = new Map<string, number>();
    const exact = context.catalog.find((d) => normalize(d.name) === query);
    if (exact) scores.set(exact.name, 1_000_000);
    for (const item of phrases) if (query.includes(normalize(item.phrase))) for (const name of item.names) scores.set(name, Math.max(scores.get(name) ?? 0, 10_000));
    const words = query.split(" ").filter((word) => word.length > 1 && !generic.has(word));
    if (words.length) for (const [name, { i }] of defs) {
        const guidance = TOOL_GUIDANCE[name as McpToolName];
        const terms = normalize([name, guidance.purpose, ...guidance.searchTerms.en, ...guidance.searchTerms.th].join(" ")).split(" ");
        const overlap = words.filter((word) => terms.includes(word)).length;
        if (overlap) scores.set(name, Math.max(scores.get(name) ?? 0, 100 + overlap * 10 - i / 10000));
    }
    const ranked = [...scores].filter(([n, score]) => defs.has(n as McpToolName) && score > 0).sort((a, b) => b[1] - a[1] || defs.get(a[0] as McpToolName)!.i - defs.get(b[0] as McpToolName)!.i);
    const visible = ranked.filter(([name]) => active.has(name as McpToolName));
    const unavailable = ranked.filter(([name]) => !active.has(name as McpToolName));
    if (unavailable.length && (!visible.length || unavailable[0]![1] > visible[0]![1])) {
        const bestScore = unavailable[0]![1];
        const requiredProfiles = (Object.keys(TOOL_PROFILES) as ToolProfile[]).filter((profile) => profile !== context.profile && unavailable.some(([name, score]) => score === bestScore && TOOL_PROFILES[profile].includes(name as McpToolName)));
        return { ...base, status: "connection_required", matches: [], hasMore: false, nextCursor: null, requiredProfiles };
    }
    if (!visible.length && ranked.length) {
        const requiredProfiles = (Object.keys(TOOL_PROFILES) as ToolProfile[]).filter((profile) => profile !== context.profile && ranked.some(([name]) => TOOL_PROFILES[profile].includes(name as McpToolName)));
        return { ...base, status: "connection_required", matches: [], hasMore: false, nextCursor: null, requiredProfiles };
    }
    if (!visible.length) return { ...base, status: "no_match", matches: [], hasMore: false, nextCursor: null, requiredProfiles: [] };
    if (input.cursor && offset >= visible.length) return { ...base, status: "refresh_required", matches: [], hasMore: false, nextCursor: null, requiredProfiles: [] };
    const ambiguous = visible.length > 1 && visible[0][1] === visible[1][1] || visible[0][1] < 200;
    const page = visible.slice(offset, offset + limit);
    const hasMore = offset + page.length < visible.length;
    const matches = page.map(([name]) => {
        const g = TOOL_GUIDANCE[name as McpToolName];
        return { toolName: name as McpToolName, purpose: g.purpose, domain: g.domain, whenToUse: g.whenToUse.slice(0, 8), prerequisites: g.prerequisites.slice(0, 8), sideEffects: g.sideEffects.slice(0, 8), retrySafety: g.retrySafety, requiresHumanConfirmation: g.requiresHumanConfirmation, relatedTools: g.relatedTools.filter((t) => active.has(t) && defs.has(t)).slice(0, 8) };
    });
    return { ...base, status: ambiguous ? "needs_clarification" : "matches", matches, hasMore, nextCursor: hasMore ? cursorEncode({ q: digest(query), p: context.profile, c: context.catalogVersion, g: context.guidanceVersion, o: offset + page.length }) : null, requiredProfiles: [] };
}
