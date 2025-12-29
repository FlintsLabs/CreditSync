import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { OAuth2Client } from "google-auth-library";
import { db } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export const authRoute = new Elysia({ prefix: "/auth" })
    .use(
        jwt({
            name: "jwt",
            secret: process.env.JWT_SECRET || "default_secret_please_change",
        })
    )
    .post("/google", async ({ body, jwt }) => {
        try {
            // 1. Verify Google Token
            // Warning: React-OAuth returns an 'access_token' (Opaque), not ID Token if using implicit flow.
            // If we want ID Token, we verify against UserInfo endpoint.

            const userInfoResponse = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${body.token}`);
            if (!userInfoResponse.ok) {
                throw new Error("Invalid Token");
            }
            const payload = await userInfoResponse.json();
            console.log("Google Payload:", JSON.stringify(payload, null, 2));

            if (!payload.email) {
                throw new Error("Email not found in token");
            }

            // 2. Check User in DB
            let user = await db.select().from(users).where(eq(users.email, payload.email)).then(res => res[0]);

            // 3. Register if Not Exists
            if (!user) {
                // Auto-register logic (Assign to default Tenant for now)
                const result = await db.insert(users).values({
                    tenantId: "default_tenant",
                    email: payload.email,
                    name: payload.name,
                    picture: payload.picture,
                    role: "owner" // First user or specific logic
                }).returning();
                user = result[0];
            } else {
                // Update existing user info to keep it fresh
                const result = await db.update(users)
                    .set({
                        name: payload.name,
                        picture: payload.picture
                    })
                    .where(eq(users.email, payload.email))
                    .returning();
                user = result[0];
            }

            // 4. Generate Session Token
            const accessToken = await jwt.sign({
                id: user.id,
                email: user.email,
                role: user.role,
                tenantId: user.tenantId
            });

            return {
                success: true,
                accessToken,
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    picture: user.picture
                }
            };

        } catch (error) {
            console.error("Auth Error", error);
            return { success: false, error: "Authentication Failed" };
        }
    }, {
        body: t.Object({
            token: t.String()
        })
    });
