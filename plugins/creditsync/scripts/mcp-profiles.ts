import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MCP_CATALOG_VERSION, advertisedMcpToolMetadata } from "../../../backend/src/mcp/server";
import { TOOL_PROFILES } from "../../../backend/src/mcp/tool-profiles";

const outputDirectory = resolve(import.meta.dir, "../references/mcp-profiles");

export type McpProfileSnapshot = {
    schemaVersion: "1.0";
    catalogVersion: string;
    profile: keyof typeof TOOL_PROFILES;
    toolCount: number;
    tools: string[];
};

export function profileSnapshots(): McpProfileSnapshot[] {
    const catalogNames = new Set(advertisedMcpToolMetadata().map((tool) => tool.name));
    return (Object.keys(TOOL_PROFILES) as Array<keyof typeof TOOL_PROFILES>).map((profile) => {
        const tools = [...TOOL_PROFILES[profile]];
        if (new Set(tools).size !== tools.length) throw new Error(`Duplicate tool in ${profile} profile`);
        if (tools.some((name) => !catalogNames.has(name))) throw new Error(`Unknown tool in ${profile} profile`);
        return { schemaVersion: "1.0", catalogVersion: MCP_CATALOG_VERSION, profile, toolCount: tools.length, tools };
    });
}

if (import.meta.main) {
    const snapshots = profileSnapshots();
    await mkdir(outputDirectory, { recursive: true });
    for (const snapshot of snapshots) {
        await writeFile(resolve(outputDirectory, `${snapshot.profile}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    }
    await writeFile(resolve(outputDirectory, "index.json"), `${JSON.stringify({ schemaVersion: "1.0", catalogVersion: MCP_CATALOG_VERSION, profiles: snapshots.map(({ profile, toolCount }) => ({ profile, toolCount })) }, null, 2)}\n`, "utf8");
    console.log(`Wrote ${snapshots.length} MCP profile snapshots to ${outputDirectory}`);
}
