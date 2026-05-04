import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { bankLoans, bankTransactions, transactions } from "../db/schema";
import { authPlugin } from "../middleware/auth";

type FundPerformancePoint = {
    name: string;
    year: number;
    liability: number;
    paymentToBank: number;
    collectedFromBorrowers: number;
    expectedCollection: number;
};

const years = [2023, 2024, 2025];
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const buildFallbackPerformance = (): FundPerformancePoint[] => {
    let currentLiability = 100000;
    const monthlyInterestRate = 0.005;
    const baseBankPayment = 6700;

    return years.flatMap((year) =>
        months.map((month, index) => {
            const interest = currentLiability * monthlyInterestRate;
            const principalRepayment = baseBankPayment - interest;
            currentLiability = Math.max(0, currentLiability - principalRepayment);

            const seasonality = 1 + ((index % 4) - 1.5) * 0.08;
            const expectedCollection = Math.round(baseBankPayment * 1.5);
            const collectedFromBorrowers = Math.round(expectedCollection * seasonality);

            return {
                name: `${month} ${year}`,
                year,
                liability: Math.round(currentLiability),
                paymentToBank: baseBankPayment,
                collectedFromBorrowers,
                expectedCollection
            };
        })
    );
};

const isDateInMonth = (dateValue: unknown, year: number, monthIndex: number) => {
    if (!dateValue) return false;

    const date = new Date(dateValue as string | number | Date);
    return !Number.isNaN(date.getTime())
        && date.getFullYear() === year
        && date.getMonth() === monthIndex;
};

export const analyticsRoute = new Elysia({ prefix: "/analytics" })
    .use(authPlugin)
    .get("/fund-performance", async ({ user, set }) => {
        if (!user?.tenantId) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const userBankLoans = await db.select()
            .from(bankLoans)
            .where(eq(bankLoans.tenantId, user.tenantId));

        const userBankTransactions = await db.select()
            .from(bankTransactions)
            .where(eq(bankTransactions.tenantId, user.tenantId));

        const userTransactions = await db.select()
            .from(transactions)
            .where(and(
                eq(transactions.tenantId, user.tenantId),
                eq(transactions.type, "repayment")
            ));

        if (userBankLoans.length === 0 && userBankTransactions.length === 0 && userTransactions.length === 0) {
            return buildFallbackPerformance();
        }

        let runningLiability = userBankLoans.reduce(
            (sum, loan) => sum + Number(loan.amount),
            0
        );

        return years.flatMap((year) =>
            months.map((monthName, monthIndex) => {
                const paymentToBank = userBankTransactions
                    .filter((tx) => isDateInMonth(tx.transactionDate, year, monthIndex))
                    .reduce((sum, tx) => sum + Number(tx.amount), 0);

                const collectedFromBorrowers = userTransactions
                    .filter((tx) => isDateInMonth(tx.transactionDate, year, monthIndex))
                    .reduce((sum, tx) => sum + Number(tx.amount), 0);

                runningLiability = Math.max(0, runningLiability - paymentToBank);

                return {
                    name: `${monthName} ${year}`,
                    year,
                    liability: Math.round(runningLiability),
                    paymentToBank: Math.round(paymentToBank),
                    collectedFromBorrowers: Math.round(collectedFromBorrowers),
                    expectedCollection: Math.round(paymentToBank * 1.5)
                };
            })
        );
    });
