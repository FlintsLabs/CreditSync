import { describe, expect, test } from "bun:test";
import { gradeToolTrace } from "../scripts/grade-tool-traces";

describe("sanitized local tool trace grading", () => {
  const fixture = { caseId: "deferral-confirmed", model: "synthetic-fixture", catalogVersion: "catalog", guidanceVersion: "guidance", toolNames: ["loan.inspect-context", "loan.schedule.defer"], outcome: "completed", confirmationEvents: [{ toolName: "loan.schedule.defer", explicit: true }] };
  test("accepts valid and reports wrong, missing, forbidden, prerequisite and confirmation issues", () => {
    expect(gradeToolTrace(fixture).validRuns).toBe(1);
    expect(gradeToolTrace({ ...fixture, toolNames: [] }).missedCalls).toBe(2);
    expect(gradeToolTrace({ ...fixture, toolNames: ["payment.post"] }).forbiddenCalls).toBe(1);
    expect(gradeToolTrace({ ...fixture, toolNames: ["loan.schedule.defer", "loan.inspect-context"] }).wrongCalls).toBe(1);
    expect(gradeToolTrace({ ...fixture, confirmationEvents: [] }).confirmationFailures).toBe(1);
    expect(() => gradeToolTrace({ ...fixture, unexpected: "raw" } as never)).toThrow();
  });
});
