const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

export type DeploymentMetadata = { timestamp: string };

export function isValidDeploymentTimestamp(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const match = ISO_TIMESTAMP_PATTERN.exec(value);
    if (!match) return false;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = secondText === undefined ? 0 : Number(secondText);
    const zoneMatch = zone === "Z" ? null : /^(?:[+-])(\d{2}):(\d{2})$/.exec(zone);
    const zoneHour = zoneMatch ? Number(zoneMatch[1]) : 0;
    const zoneMinute = zoneMatch ? Number(zoneMatch[2]) : 0;
    if (hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) return false;
    const datePart = `${yearText}-${monthText}-${dayText}`;
    const calendarDate = new Date(`${datePart}T00:00:00Z`);
    return Number.isFinite(Date.parse(value)) && calendarDate.getUTCFullYear() === year
        && calendarDate.getUTCMonth() + 1 === month && calendarDate.getUTCDate() === day;
}

export function parseDeploymentMetadata(value: unknown): DeploymentMetadata | null {
    if (!value || typeof value !== "object" || !("timestamp" in value)) return null;
    const timestamp = (value as { timestamp?: unknown }).timestamp;
    return isValidDeploymentTimestamp(timestamp) ? { timestamp } : null;
}

export function formatDeploymentTimestamp(timestamp: string, language: string): string {
    return `${new Intl.DateTimeFormat(language, {
        timeZone: "Asia/Bangkok",
        dateStyle: "long",
        timeStyle: "short",
    }).format(new Date(timestamp))} (UTC+7)`;
}
