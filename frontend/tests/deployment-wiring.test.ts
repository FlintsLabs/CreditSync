import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const frontendRoot = resolve(import.meta.dirname, "..");

it("keeps deployment metadata runtime-only and supplies it from compose deployment env", async () => {
    const dockerfile = await readFile(resolve(frontendRoot, "Dockerfile"), "utf8");
    const compose = await readFile(resolve(frontendRoot, "../docker-compose.app.yml"), "utf8");
    const nginx = await readFile(resolve(frontendRoot, "nginx.conf"), "utf8");
    const entrypoint = await readFile(resolve(frontendRoot, "docker-entrypoint.d/40-deployment-metadata.sh"), "utf8");
    const layout = await readFile(resolve(frontendRoot, "src/layouts/DashboardLayout.tsx"), "utf8");

    expect(dockerfile).toContain("COPY docker-entrypoint.d/ /docker-entrypoint.d/");
    expect(compose).toContain("DEPLOYED_AT: ${DEPLOYED_AT:-}");
    expect(entrypoint).toContain("/usr/share/nginx/html/deployment.json");
    expect(layout).toContain('import DeploymentTimestamp from "../components/DeploymentTimestamp";');
    expect(layout).toContain("<DeploymentTimestamp");
    expect(entrypoint).toContain("DEPLOYED_AT");
    expect(nginx).toContain("location = /deployment.json");
    expect(nginx).toContain("Cache-Control \"no-store\"");
    expect(nginx).toContain("try_files /deployment.json =404;");
    expect(nginx).not.toContain("location /deployment.json");
    expect(existsSync(resolve(frontendRoot, "tests/deployment-wiring.test.ts"))).toBe(true);
});
