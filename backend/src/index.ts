import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { bankProfilesRoute } from "./modules/bank-profiles";
import { borrowersRoute } from "./modules/borrowers";
import { authRoute } from "./modules/auth";
import { filesRoute } from "./modules/files";
import { loansRoute } from "./modules/loans";
import { transactionsRoute } from "./modules/transactions";

const app = new Elysia()
    .use(cors())
    .use(swagger())
    .get("/", () => "Hello CreditSync")
    .use(authRoute)
    .use(bankProfilesRoute)
    .use(borrowersRoute)
    .use(filesRoute)
    .use(loansRoute)
    .use(transactionsRoute)
    .listen(3000);

console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
