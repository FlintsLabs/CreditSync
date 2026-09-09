import postgres from "postgres";
import {
    assertCompatibleLoanOriginationSchema,
    inspectLoanOriginationSchema,
} from "../src/db/loan-origination-schema-contract";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const sql = postgres(databaseUrl, { max: 1 });
try {
    const report = await inspectLoanOriginationSchema(sql);
    for (const object of report.objects) console.log(`${object.name}: ${object.state}`);
    assertCompatibleLoanOriginationSchema(report);
} finally {
    await sql.end();
}
