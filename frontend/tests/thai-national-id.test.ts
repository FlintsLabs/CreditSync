import { describe, expect, test } from "vitest";
import {
  formatThaiNationalId,
  maskThaiNationalId,
} from "../src/lib/thai-national-id";

describe("Thai national-ID presentation", () => {
  test("formats and masks a 13-digit ID without changing its raw value", () => {
    expect(formatThaiNationalId("1234567890123")).toBe("1-2345-67890-12-3");
    expect(maskThaiNationalId("1234567890123")).toBe("1-2345-•••••-12-3");
  });

  test("returns null for absent, non-numeric, or wrong-length values", () => {
    expect(formatThaiNationalId(null)).toBeNull();
    expect(formatThaiNationalId("12345A7890123")).toBeNull();
    expect(maskThaiNationalId("123456789012")).toBeNull();
  });
});
