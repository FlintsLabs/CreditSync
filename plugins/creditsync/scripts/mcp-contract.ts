import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
    canonicalContractJson,
    captureAdvertisedMcpContract,
} from "../../../backend/src/mcp/contract-snapshot";

export { canonicalContractJson, captureAdvertisedMcpContract };

if (import.meta.main) {
    const contract = await captureAdvertisedMcpContract();
    const output = canonicalContractJson(contract);
    if (process.argv.includes("--write")) {
        const path = resolve(import.meta.dir, "../references/mcp-tool-contract.json");
        await writeFile(path, output, "utf8");
        console.log(`Wrote ${contract.tools.length} advertised MCP tools to ${path}`);
    } else {
        process.stdout.write(output);
    }
}
