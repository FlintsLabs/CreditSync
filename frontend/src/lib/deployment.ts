const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export type DeploymentMetadata = { timestamp: string };

export function isValidDeploymentTimestamp(value: unknown): value is string {
    if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
    const [datePart] = value.split("T");
    const [year, month, day] = datePart.split("-").map(Number);
    const calendarDate = new Date(`${datePart}T00:00:00Z`);
    return Number.isFinite(Date.parse(value))
        && calendarDate.getUTCFullYear() === year
        && calendarDate.getUTCMonth() + 1 === month
        && calendarDate.getUTCDate() === day;
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
