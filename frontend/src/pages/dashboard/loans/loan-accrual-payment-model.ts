import { FinancialDecimal } from "../../../lib/financial-decimal";

export function sumAccrualMoney(values: string[]): string {
    return values.reduce((sum, value) => sum.plus(value), new FinancialDecimal(0)).toFixed(2);
}
