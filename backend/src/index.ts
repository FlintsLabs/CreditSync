import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { authPlugin } from "./middleware/auth";
import { bankProfilesRoute } from "./modules/bank-profiles";
import { bankLoansRoute } from "./modules/bank-loans";
import { borrowersRoute } from "./modules/borrowers";
import { authRoute } from "./modules/auth";
import { filesRoute } from "./modules/files";
import { fundRolloversRoute } from "./modules/fund-rollovers";
import { loansRoute } from "./modules/loans";
import { transactionsRoute } from "./modules/transactions";
import { webhookRoute } from "./modules/webhook";
import { auditLogsRoute } from "./modules/audit-logs";
import { dashboardRoute } from "./modules/dashboard";
import { reconciliationRoute } from "./modules/reconciliation";
import { paymentIntakesRoute } from "./modules/payment-intakes";

const isProd = process.env.NODE_ENV === "production";
const corsOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const app = new Elysia()
    .use(cors({
        origin: isProd ? corsOrigins : true,
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
    .guard({ isLoggedIn: true }, (app) =>
        app
            .use(bankProfilesRoute)
            .use(bankLoansRoute)
            .use(borrowersRoute)
            .use(filesRoute)
            .use(fundRolloversRoute)
            .use(loansRoute)
            .use(transactionsRoute)
            .use(paymentIntakesRoute)
            .use(auditLogsRoute)
            .use(dashboardRoute)
            .use(reconciliationRoute)
    )
    .listen({
        port: 3000,
        hostname: '0.0.0.0'
    });

console.log(
    `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`
);
