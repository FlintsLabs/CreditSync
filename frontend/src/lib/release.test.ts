import { describe, expect, test } from "bun:test";
import { APPLICATION_VERSION, MCP_SCHEMA_VERSION, PLUGIN_VERSION } from "./release";

describe("release metadata", () => {
    test("tracks the scheduled allocation correction plugin contract", () => {
        expect(APPLICATION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
        expect(MCP_SCHEMA_VERSION).toBe("1.0");
        expect(PLUGIN_VERSION).toBe("9.1.0");
    });
});
