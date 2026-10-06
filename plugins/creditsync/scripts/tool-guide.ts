import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { advertisedMcpToolMetadata, MCP_CATALOG_VERSION } from "../../../backend/src/mcp/server";
import { TOOL_GUIDANCE_VERSION, TOOL_GUIDANCE } from "../../../backend/src/mcp/tool-guidance";
import { TOOL_PROFILES } from "../../../backend/src/mcp/tool-profiles";

export function generateToolGuide() {
 const catalog = advertisedMcpToolMetadata(); const names = catalog.map(t => t.name); const nameSet = new Set(names); if (nameSet.size !== names.length) throw new Error("catalog has duplicate tool names");
 const rows = catalog.map((tool) => { const g = TOOL_GUIDANCE[tool.name]; if (!g) throw new Error(`missing guidance ${tool.name}`); for (const related of g.relatedTools) if (!nameSet.has(related)) throw new Error(`unknown related tool ${related} in ${tool.name}`); const profiles = Object.entries(TOOL_PROFILES).filter(([, tools]) => tools.includes(tool.name)).map(([name]) => name); return [`## \`${tool.name}\``, ``, `**Description:** ${tool.description ?? ""}`, ``, `**Purpose:** ${g.purpose}`, ``, `**Profiles:** ${profiles.join(", ")}`, ``, `**When to use:** ${g.whenToUse.slice(0, 4).join(" ")}`, ``, `**Prerequisites:** ${g.prerequisites.slice(0, 4).join(" ")}`, ``, `**Effects:** ${g.sideEffects.slice(0, 4).join(" ") || "None; read-only metadata or domain read."}`, ``, `**Retry:** ${g.retrySafety}`, ``, `**Human confirmation:** ${g.requiresHumanConfirmation ? "Required where the operation creates or changes financial/business state; inspect and preview first." : "Not required for this tool itself."}`, ``, `**Related tools:** ${g.relatedTools.slice(0, 8).join(", ") || "None"}`].join("\n"); });
 return `# MCP tool guide\n\nGenerated from the serving backend catalog and exhaustive guidance registry. This document describes metadata and does not authorize execution.\n\nCatalog version: \`${MCP_CATALOG_VERSION}\`\nGuidance version: \`${TOOL_GUIDANCE_VERSION}\`\nTool count: ${catalog.length}\n\n${rows.join("\n\n") }\n`;
}
if (import.meta.main) { const output = generateToolGuide(); if (!process.argv.includes("--write")) process.stdout.write(output); else { const path = resolve(import.meta.dir, "../references/tool-guide.md"); await writeFile(path, output, "utf8"); console.log(`Wrote generated guide to ${path}`); } }
