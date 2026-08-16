export function bangkokLocalDateTimeToIso(value: string) {
    return new Date(`${value}:00+07:00`).toISOString();
}
