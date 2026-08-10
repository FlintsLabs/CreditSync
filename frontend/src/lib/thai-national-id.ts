const THAI_NATIONAL_ID = /^\d{13}$/u;

function normalizeThaiNationalId(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const digits = value.replace(/\D/g, "");
  return THAI_NATIONAL_ID.test(digits) ? digits : null;
}

export function formatThaiNationalId(value: unknown): string | null {
  const digits = normalizeThaiNationalId(value);
  if (!digits) return null;

  return `${digits[0]}-${digits.slice(1, 5)}-${digits.slice(5, 10)}-${digits.slice(10, 12)}-${digits[12]}`;
}

export function maskThaiNationalId(value: unknown): string | null {
  const formatted = formatThaiNationalId(value);
  return formatted ? `${formatted.slice(0, 7)}•••••${formatted.slice(-5)}` : null;
}
