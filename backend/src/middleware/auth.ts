import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";

export const authPlugin = (app: Elysia) =>
    app
        .use(
            jwt({
                name: "jwt",
                secret: process.env.JWT_SECRET || "default_secret_please_change",
            })
        )
        .derive(async ({ jwt, cookie: { auth }, headers }) => {
            const token = auth?.value || headers.authorization?.replace("Bearer ", "");
            if (!token) return { user: null };

            const profile = await jwt.verify(token);
            if (!profile) return { user: null };

            return {
                user: {
                    id: profile.id as number,
                    email: profile.email as string,
                    role: profile.role as string,
                    tenantId: profile.tenantId as string,
                },
            };
        })
        .macro({
            isLoggedIn(enabled: boolean) {
                if (!enabled) return;
                return {
                    beforeHandle({ user, set }) {
                        if (!user) {
                            set.status = 401;
                            return { error: "Unauthorized" };
                        }
                    },
                };
            },
            role(allowedRoles: string[]) {
                return {
                    beforeHandle({ user, set }) {
                        if (!user) {
                            set.status = 401;
                            return { error: "Unauthorized" };
                        }
                        if (!allowedRoles.includes(user.role)) {
                            set.status = 403;
                            return { error: "Forbidden" };
                        }
                    },
                };
            },
        });
