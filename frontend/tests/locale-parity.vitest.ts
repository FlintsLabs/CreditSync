import { describe, expect, it } from "vitest";
import en from "../src/locales/en.json";
import th from "../src/locales/th.json";

const leafKeys = (value: unknown, prefix = ""): string[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
};

describe("locale contract", () => {
  it("keeps every English and Thai translation leaf on the same key path", () => {
    expect(leafKeys(th).sort()).toEqual(leafKeys(en).sort());
  });
});
