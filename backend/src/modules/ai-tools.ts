import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import { db } from "../db";
import { borrowers, loans } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { calculateLoanSchedule } from "../lib/calculator";

export const aiToolsRoute = new Elysia({ prefix: '/ai-tools' })
    .use(authPlugin)
    .guard({ isLoggedIn: true }, (app) => app
        .get('/tools', () => {
            return {
                tools: [
                    {
                        name: "getBorrowers",
                        description: "Retrieves a list of all borrowers for the authenticated user/tenant.",
                        parameters: {
                            type: "object",
                            properties: {}
                        }
                    },
                    {
                        name: "calculateLoanSchedule",
                        description: "Calculates the amortization schedule for a loan.",
                        parameters: {
                            type: "object",
                            properties: {
                                principal: { type: "number", description: "The total loan amount" },
                                interestRate: { type: "number", description: "The interest rate percentage (e.g., 20 for 20%)" },
                                startDate: { type: "string", description: "The start date of the loan (YYYY-MM-DD)" },
                                frequency: { type: "string", enum: ["daily", "weekly", "monthly"], description: "The payment frequency" },
                                duration: { type: "number", description: "The duration of the loan in terms of the frequency" }
                            },
                            required: ["principal", "interestRate", "startDate", "frequency", "duration"]
                        }
                    }
                ]
            };
        })
        .post('/execute', async ({ body, user }) => {
            const { toolName, parameters } = body as { toolName: string, parameters: any };

            if (!user?.tenantId) {
                return { error: "Unauthorized" };
            }

            try {
                if (toolName === "getBorrowers") {
                    const data = await db.select().from(borrowers).where(eq(borrowers.tenantId, user.tenantId));
                    return { success: true, result: data };
                }

                if (toolName === "calculateLoanSchedule") {
                    const { principal, interestRate, startDate, frequency, duration } = parameters;
                    const schedule = calculateLoanSchedule(
                        Number(principal),
                        Number(interestRate),
                        new Date(startDate),
                        frequency as "daily" | "weekly" | "monthly",
                        Number(duration)
                    );
                    return { success: true, result: schedule };
                }

                return { error: `Tool ${toolName} not found or not supported.` };

            } catch (error: any) {
                return { error: `Tool execution failed: ${error.message}` };
            }
        }, {
            body: t.Object({
                toolName: t.String(),
                parameters: t.Optional(t.Any())
            })
        })
    );
