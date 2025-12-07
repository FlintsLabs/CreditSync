import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { bankProfilesRoute } from "./modules/bank-profiles";
import { borrowersRoute } from "./modules/borrowers";

const app = new Elysia()
    .use(cors())
    .use(swagger())
    .get("/", () => "Hello CreditSync")
    .use(bankProfilesRoute)
    .use(borrowersRoute)
    .listen(3000);

console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
