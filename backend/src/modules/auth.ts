import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { OAuth2Client } from "google-auth-library";
import { db } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const defaultTenantId = process.env.DEFAULT_TENANT_ID;
const isProd = process.env.NODE_ENV === "production";
const jwtSecret = process.env.JWT_SECRET || (isProd ? undefined : "dev_jwt_secret_change_me");
if (!jwtSecret) {
    throw new Error("JWT_SECRET is required in production");
}

export const authRoute = new Elysia({ prefix: "/auth" })
    .use(
        jwt({
            name: "jwt",
            secret: jwtSecret,
        })
    )
    .post("/google", async ({ body, jwt, set }) => {
        try {
            const ticket = await client.verifyIdToken({
                idToken: body.idToken,
                audience: process.env.GOOGLE_CLIENT_ID,
            });
            const payload = ticket.getPayload();
            if (!payload) {
                throw new Error("Invalid Google token payload");
            }

            if (!payload.email) {
                throw new Error("Email not found in token");
            }
            if (!payload.email_verified) {
                throw new Error("Google account email is not verified");
            }

            // 2. Check User in DB
            let user = await db.select().from(users).where(eq(users.email, payload.email)).then(res => res[0]);

            // 3. Register if Not Exists
            if (!user) {
                if (!defaultTenantId) {
                    throw new Error("DEFAULT_TENANT_ID is not configured");
                }
                const existingTenantUsers = await db.select({ id: users.id })
                    .from(users)
                    .where(eq(users.tenantId, defaultTenantId))
                    .limit(1);
                const result = await db.insert(users).values({
                    tenantId: defaultTenantId,
                    email: payload.email,
                    name: payload.name,
                    picture: payload.picture,
                    role: existingTenantUsers.length === 0 ? "owner" : "viewer"
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
                    tenantId: user.tenantId,
                    role: user.role,
                    picture: user.picture
                }
            };

        } catch (error) {
            console.error("Auth Error", error);
            set.status = 401;
            return { success: false, error: "Authentication Failed" };
        }
    }, {
        body: t.Object({
            idToken: t.String()
        })
    });
