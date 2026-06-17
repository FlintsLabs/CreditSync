import { Elysia, t } from "elysia";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loans, transactions } from "../db/schema";
import { authPlugin } from "../middleware/auth";

const toolsSchemas = [
    {
        name: "get_borrower_summary",
        description: "Get a summary of a specific borrower including active loans and outstanding balance.",
        parameters: {
            type: "object",
            properties: {
                borrowerId: {
                    type: "number",
                    description: "The ID of the borrower to look up."
                }
            },
            required: ["borrowerId"]
        }
    },
    {
        name: "get_active_loans",
        description: "Retrieve active loans for the current tenant.",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    },
    {
        name: "get_financial_overview",
        description: "Get a high-level financial overview including total lent, collected, and active principal.",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    }
];

const executeToolBodySchema = t.Union([
    t.Object({
        tool: t.Literal("get_borrower_summary"),
        parameters: t.Object({
            borrowerId: t.Number()
        })
    }),
    t.Object({
        tool: t.Literal("get_active_loans"),
        parameters: t.Object({})
    }),
    t.Object({
        tool: t.Literal("get_financial_overview"),
        parameters: t.Object({})
    })
]);

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .get("/tools", ({ user, set }) => {
        if (!user?.tenantId) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        return toolsSchemas;
    })
    .post("/chat", async ({ body, user, set }) => {
        if (!user?.tenantId) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const messages = body.messages as { role: string; content: string }[];
        if (!messages || messages.length === 0) {
            set.status = 400;
            return { error: "Messages are required" };
        }

        const lastMessage = messages[messages.length - 1].content.toLowerCase();
        let toolToExecute = null;
        let toolParams = {};

        // Simple intent parsing
        if (lastMessage.includes("ลูกหนี้") && (lastMessage.includes("ทั้งหมด") || lastMessage.includes("active"))) {
            toolToExecute = "get_active_loans";
        } else if (lastMessage.includes("สรุป") || lastMessage.includes("ภาพรวม") || lastMessage.includes("การเงิน")) {
            toolToExecute = "get_financial_overview";
        } else if (lastMessage.includes("ลูกหนี้")) {
            // Check if there's a number in the message
            const match = lastMessage.match(/\d+/);
            if (match) {
                toolToExecute = "get_borrower_summary";
                toolParams = { borrowerId: parseInt(match[0], 10) };
            } else {
                return {
                    response: "กรุณาระบุ ID ของลูกหนี้ที่ต้องการดูข้อมูล เช่น 'ขอดูข้อมูลลูกหนี้ ID 1' ค่ะ"
                };
            }
        }

        if (!toolToExecute) {
            return {
                response: "ฉันคือผู้ช่วย AI ของ CreditSync คุณสามารถถามฉันเกี่ยวกับ ภาพรวมการเงิน, รายชื่อลูกหนี้ทั้งหมด, หรือ ข้อมูลลูกหนี้รายบุคคล (ระบุ ID) ได้ค่ะ"
            };
        }

        try {
            // Internal execute logic mapping
            let result;
            let responseText = "";

            switch (toolToExecute) {
                case "get_borrower_summary": {
                    const borrowerId = (toolParams as any).borrowerId;
                    const borrower = await db.query.borrowers.findFirst({
                        where: and(
                            eq(borrowers.id, borrowerId),
                            eq(borrowers.tenantId, user.tenantId)
                        )
                    });

                    if (!borrower) {
                        return { response: "ไม่พบข้อมูลลูกหนี้รายนี้ค่ะ" };
                    }

                    const activeLoans = await db.select()
                        .from(loans)
                        .where(and(
                            eq(loans.borrowerId, borrowerId),
                            eq(loans.tenantId, user.tenantId),
                            eq(loans.status, "active")
                        ));

                    const loanIds = activeLoans.map((loan) => loan.id);
                    let totalPaid = 0;

                    if (loanIds.length > 0) {
                        const [txsResult] = await db.select({
                            total: sql<number>`cast(coalesce(sum(${transactions.amount}), 0) as float)`
                        })
                            .from(transactions)
                            .where(and(
                                eq(transactions.tenantId, user.tenantId),
                                inArray(transactions.loanId, loanIds)
                            ));
                        totalPaid = Number(txsResult?.total ?? 0);
                    }

                    const totalPrincipal = activeLoans.reduce((sum, loan) => sum + Number(loan.principalAmount), 0);
                    result = {
                        borrower: { id: borrower.id, name: borrower.name },
                        activeLoansCount: activeLoans.length,
                        totalPrincipalLent: totalPrincipal,
                        totalRepaid: totalPaid,
                        estimatedOutstandingPrincipal: totalPrincipal - totalPaid
                    };
                    responseText = `ข้อมูลของ ${borrower.name} (ID: ${borrower.id}): มีสินเชื่อที่กำลังใช้งานอยู่ ${activeLoans.length} รายการ ยอดกู้รวม ${totalPrincipal.toLocaleString()} บาท ชำระแล้ว ${totalPaid.toLocaleString()} บาท คงเหลือประมาณ ${(totalPrincipal - totalPaid).toLocaleString()} บาทค่ะ`;
                    break;
                }
                case "get_active_loans": {
                    const activeLoans = await db.select({
                        id: loans.id,
                        principalAmount: loans.principalAmount
                    })
                        .from(loans)
                        .where(and(
                            eq(loans.tenantId, user.tenantId),
                            eq(loans.status, "active")
                        ))
                        .limit(20);
                    result = { loans: activeLoans };
                    responseText = `ปัจจุบันมีสินเชื่อที่กำลังใช้งานอยู่ทั้งหมด ${activeLoans.length} รายการค่ะ`;
                    break;
                }
                case "get_financial_overview": {
                    const [loanAgg] = await db.select({
                        totalLent: sql<number>`cast(coalesce(sum(${loans.principalAmount}), 0) as float)`,
                        activePrincipal: sql<number>`cast(coalesce(sum(case when ${loans.status} = 'active' then ${loans.principalAmount} else 0 end), 0) as float)`
                    })
                        .from(loans)
                        .where(eq(loans.tenantId, user.tenantId));

                    const [txAgg] = await db.select({
                        totalCollected: sql<number>`cast(coalesce(sum(${transactions.amount}), 0) as float)`
                    })
                        .from(transactions)
                        .where(eq(transactions.tenantId, user.tenantId));

                    result = {
                        totalLent: Number(loanAgg?.totalLent ?? 0),
                        totalCollected: Number(txAgg?.totalCollected ?? 0),
                        activePrincipal: Number(loanAgg?.activePrincipal ?? 0)
                    };
                    responseText = `ภาพรวมการเงิน: ปล่อยกู้ไปแล้วทั้งหมด ${result.totalLent.toLocaleString()} บาท เก็บเงินคืนได้ ${result.totalCollected.toLocaleString()} บาท และมีเงินต้นที่กำลังดำเนินการอยู่ ${result.activePrincipal.toLocaleString()} บาทค่ะ`;
                    break;
                }
            }

            return {
                response: responseText,
                data: result
            };
        } catch (error) {
            console.error("AI chat execution failed:", error);
            set.status = 500;
            return { error: "Failed to process chat request" };
        }
    }, {
        body: t.Object({
            messages: t.Array(t.Object({
                role: t.String(),
                content: t.String()
            }))
        })
    })
    .post("/execute", async ({ body, user, set }) => {
        if (!user?.tenantId) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        try {
            switch (body.tool) {
                case "get_borrower_summary": {
                    const borrowerId = body.parameters.borrowerId;

                    const borrower = await db.query.borrowers.findFirst({
                        where: and(
                            eq(borrowers.id, borrowerId),
                            eq(borrowers.tenantId, user.tenantId)
                        )
                    });

                    if (!borrower) {
                        set.status = 404;
                        return { error: "Borrower not found" };
                    }

                    const activeLoans = await db.select()
                        .from(loans)
                        .where(and(
                            eq(loans.borrowerId, borrowerId),
                            eq(loans.tenantId, user.tenantId),
                            eq(loans.status, "active")
                        ));

                    const loanIds = activeLoans.map((loan) => loan.id);
                    let totalPaid = 0;

                    if (loanIds.length > 0) {
                        const [txsResult] = await db.select({
                            total: sql<number>`cast(coalesce(sum(${transactions.amount}), 0) as float)`
                        })
                            .from(transactions)
                            .where(and(
                                eq(transactions.tenantId, user.tenantId),
                                inArray(transactions.loanId, loanIds)
                            ));

                        totalPaid = Number(txsResult?.total ?? 0);
                    }

                    const totalPrincipal = activeLoans.reduce(
                        (sum, loan) => sum + Number(loan.principalAmount),
                        0
                    );

                    return {
                        borrower: {
                            id: borrower.id,
                            name: borrower.name,
                            idCardNumber: borrower.idCardNumber,
                            creditScore: borrower.creditScore
                        },
                        activeLoansCount: activeLoans.length,
                        totalPrincipalLent: totalPrincipal,
                        totalRepaid: totalPaid,
                        estimatedOutstandingPrincipal: totalPrincipal - totalPaid
                    };
                }

                case "get_active_loans": {
                    const activeLoans = await db.select({
                        id: loans.id,
                        borrowerName: borrowers.name,
                        principalAmount: loans.principalAmount,
                        installmentAmount: loans.installmentAmount,
                        repaymentType: loans.repaymentType,
                        interestRate: loans.interestRate,
                        startDate: loans.startDate
                    })
                        .from(loans)
                        .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
                        .where(and(
                            eq(loans.tenantId, user.tenantId),
                            eq(loans.status, "active")
                        ))
                        .orderBy(desc(loans.createdAt))
                        .limit(20);

                    return { loans: activeLoans };
                }

                case "get_financial_overview": {
                    const [loanAgg] = await db.select({
                        totalLent: sql<number>`cast(coalesce(sum(${loans.principalAmount}), 0) as float)`,
                        activePrincipal: sql<number>`cast(coalesce(sum(case when ${loans.status} = 'active' then ${loans.principalAmount} else 0 end), 0) as float)`
                    })
                        .from(loans)
                        .where(eq(loans.tenantId, user.tenantId));

                    const [txAgg] = await db.select({
                        totalCollected: sql<number>`cast(coalesce(sum(${transactions.amount}), 0) as float)`
                    })
                        .from(transactions)
                        .where(eq(transactions.tenantId, user.tenantId));

                    return {
                        totalLent: Number(loanAgg?.totalLent ?? 0),
                        totalCollected: Number(txAgg?.totalCollected ?? 0),
                        activePrincipal: Number(loanAgg?.activePrincipal ?? 0)
                    };
                }
            }
        } catch (error) {
            console.error("AI tool execution failed:", error);
            set.status = 500;
            return { error: "Failed to execute tool" };
        }
    }, {
        body: executeToolBodySchema
    });
