import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { authPlugin } from "./middleware/auth";
import { bankProfilesRoute } from "./modules/bank-profiles";
import { bankLoansRoute } from "./modules/bank-loans";
import { borrowersRoute } from "./modules/borrowers";
import { authRoute } from "./modules/auth";
import { filesRoute } from "./modules/files";
import { loansRoute } from "./modules/loans";
import { transactionsRoute } from "./modules/transactions";
import { webhookRoute } from "./modules/webhook";
import { aiToolsRoute } from "./modules/ai-tools";

const app = new Elysia()
    .use(cors({
        origin: true, // Allow all origins for development mainly
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization'],
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
    }))
    .use(swagger())
    .onRequest(({ request }) => {
        console.log(`[${new Date().toISOString()}] ${request.method} ${request.url}`);
    })
    .get("/", () => "Hello CreditSync")
    .use(authPlugin)
    .use(authRoute)
    .use(webhookRoute) // Webhook has its own signature verification
    .use(aiToolsRoute) // AI MCP tools readiness endpoint
    .guard({ isLoggedIn: true }, (app) =>
        app
            .use(bankProfilesRoute)
            .use(bankLoansRoute)
            .use(borrowersRoute)
            .use(filesRoute)
            .use(loansRoute)
            .use(transactionsRoute)
    )
    .listen({
        port: 3000,
        hostname: '0.0.0.0'
    });

console.log(
    `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`
);
