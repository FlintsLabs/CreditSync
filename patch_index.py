with open('backend/src/index.ts', 'r') as f:
    content = f.read()

if 'import { mcpRoute } from "./modules/mcp";' not in content:
    content = content.replace('import { webhookRoute } from "./modules/webhook";', 'import { webhookRoute } from "./modules/webhook";\nimport { mcpRoute } from "./modules/mcp";')
    content = content.replace('.use(authRoute)', '.use(authRoute)\n    .use(mcpRoute)')

with open('backend/src/index.ts', 'w') as f:
    f.write(content)
