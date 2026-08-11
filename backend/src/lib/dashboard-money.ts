import Decimal from "decimal.js";

const money = (value: Decimal.Value) => new Decimal(value).toDecimalPlaces(2).toFixed(2);

export function sumDashboardMoney(values: Decimal.Value[]) {
    return money(values.reduce<Decimal>((total, value) => total.plus(value), new Decimal(0)));
}

export function subtractDashboardMoney(left: Decimal.Value, right: Decimal.Value) {
    return money(new Decimal(left).minus(right));
}

export function positiveDashboardDifference(total: Decimal.Value, allocated: Decimal.Value) {
    return money(Decimal.max(0, new Decimal(total).minus(allocated)));
}

export function aggregateDashboardMoney<Key>(rows: Array<{ key: Key; amount: Decimal.Value }>) {
    const totals = new Map<Key, string>();
    for (const row of rows) totals.set(row.key, sumDashboardMoney([totals.get(row.key) ?? "0.00", row.amount]));
    return totals;
}

export function isPositiveDashboardMoney(value: Decimal.Value) {
    return new Decimal(value).gt(0);
}

export function compareDashboardMoneyDescending(left: Decimal.Value, right: Decimal.Value) {
    return new Decimal(right).comparedTo(left);
}

interface DashboardProfitabilityValues {
    borrowerRevenueCollected: Decimal.Value;
    fundCostPaid: Decimal.Value;
    realizedSpread: Decimal.Value;
    unrealizedSpread: Decimal.Value;
    deployedPrincipal: Decimal.Value;
    netCashPosition: Decimal.Value;
    realizedRoiPercent: Decimal.Value;
    carryForwardAvailable: Decimal.Value;
}

export function serializeDashboardProfitability(values: DashboardProfitabilityValues) {
    return {
        borrowerRevenueCollected: money(values.borrowerRevenueCollected),
        fundCostPaid: money(values.fundCostPaid),
        realizedSpread: money(values.realizedSpread),
        unrealizedSpread: money(values.unrealizedSpread),
        deployedPrincipal: money(values.deployedPrincipal),
        netCashPosition: money(values.netCashPosition),
        realizedRoiPercent: money(values.realizedRoiPercent),
        carryForwardAvailable: money(values.carryForwardAvailable),
    };
}
