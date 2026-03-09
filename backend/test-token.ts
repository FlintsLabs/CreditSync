import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";

const app = new Elysia()
    .use(
        jwt({
            name: "jwt",
            secret: "dummy_secret",
        })
    )
    .get("/sign", async ({ jwt }) => {
        const token = await jwt.sign({
            id: 1,
            email: "test@example.com",
            role: "owner",
            tenantId: "mock-tenant"
        });
        return { token };
    })
    .listen(3001);
