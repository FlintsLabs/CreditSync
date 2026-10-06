import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { searchToolCatalog } from "../../../backend/src/mcp/tool-catalog-search";
import { TOOL_GUIDANCE_VERSION } from "../../../backend/src/mcp/tool-guidance";
import { MCP_CATALOG_VERSION, advertisedMcpToolMetadata } from "../../../backend/src/mcp/server";
import type { ToolProfile } from "../../../backend/src/mcp/catalog-types";

type Case = { caseId: string; query: string; profile: ToolProfile; expectedCandidates: string[]; forbiddenCandidates: string[]; expectedStatus: string; knownGuidanceVersion?: string };
const file = JSON.parse(await readFile(resolve(import.meta.dir, "../evals/discovery-cases.json"), "utf8")) as { cases: Case[] };
export const DISCOVERY_CASES = file.cases;
export function evaluateDiscoveryCases(cases: readonly Case[]) {
 const results = cases.map((c) => { const result = searchToolCatalog({ query: c.query, limit: 10, ...(c.knownGuidanceVersion ? { knownGuidanceVersion: c.knownGuidanceVersion } : {}) }, { profile: c.profile, catalogVersion: MCP_CATALOG_VERSION, guidanceVersion: TOOL_GUIDANCE_VERSION, catalog: advertisedMcpToolMetadata() }); const names = result.matches.map((m) => m.toolName); return { caseId: c.caseId, status: result.status, names, c }; });
 const candidateRecall = cases.length ? results.reduce((sum, r) => sum + r.c.expectedCandidates.filter((n) => r.names.includes(n)).length, 0) / Math.max(1, cases.reduce((sum, c) => sum + c.expectedCandidates.length, 0)) : 1;
 const unambiguous = results.filter((r) => r.c.expectedStatus === "matches"); const firstChoiceAccuracy = unambiguous.length ? unambiguous.filter((r) => r.names[0] === r.c.expectedCandidates[0]).length / unambiguous.length : 1;
 const statusMismatches = results.filter((r) => r.status !== r.c.expectedStatus).map((r) => ({ caseId: r.c.caseId, expected: r.c.expectedStatus, actual: r.status })); const forbiddenMatches = results.reduce((sum, r) => sum + r.c.forbiddenCandidates.filter((n) => r.names.includes(n)).length, 0); const safeStops = results.filter((r) => ["no_match", "needs_clarification", "connection_required", "refresh_required"].includes(r.status) && r.status === r.c.expectedStatus).length; const safeStopCases = results.filter((r) => ["no_match", "needs_clarification", "connection_required", "refresh_required"].includes(r.c.expectedStatus)).length;
 return { caseCount: cases.length, candidateRecall, firstChoiceAccuracy, statusMismatches, forbiddenMatches, safeStops, safeStopCases, modelEvaluation: "not_run" as const, results: results.map(({ caseId, status, names }) => ({ caseId, status, names })) };
}
if (import.meta.main) { const report = evaluateDiscoveryCases(DISCOVERY_CASES); console.log(JSON.stringify(report, null, 2)); if (report.candidateRecall < 1 || report.forbiddenMatches || report.statusMismatches.length) process.exit(1); }
