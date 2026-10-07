import { describe, expect, test } from "bun:test";
import { DISCOVERY_CASES, evaluateDiscoveryCases } from "../scripts/evaluate-discovery";

describe("deterministic MCP discovery evaluation", () => {
  test("covers required distinctions and returns safe metadata-only results", () => {
    const report = evaluateDiscoveryCases(DISCOVERY_CASES);
    expect(report.caseCount).toBeGreaterThanOrEqual(12);
    expect(report.candidateRecall).toBe(1);
    expect(report.forbiddenMatches).toBe(0);
    expect(report.statusMismatches).toEqual([]);
    expect(report.safeStops).toBe(report.safeStopCases);
    expect(report.modelEvaluation).toBe("not_run");
    expect(DISCOVERY_CASES.map((item) => item.caseId)).toEqual([...new Set(DISCOVERY_CASES.map((item) => item.caseId))]);
  });
});
