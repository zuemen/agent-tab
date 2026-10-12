import { describe, expect, it } from "vitest";
import { centsToValue, formatUsd, parseUsd, valueToCents } from "../src/index.ts";

describe("money", () => {
  it("parses and formats micro-USD exactly", () => {
    expect(parseUsd("0.005")).toBe(5_000);
    expect(parseUsd("12.34")).toBe(12_340_000);
    expect(parseUsd("1")).toBe(1_000_000);
    expect(formatUsd(5_000)).toBe("0.005");
    expect(formatUsd(12_340_000)).toBe("12.34");
    expect(formatUsd(0)).toBe("0.00");
  });
  it("rejects malformed amounts", () => {
    for (const bad of ["", "-1", "01", "1.1234567", "1e3", "abc", " 1"]) expect(() => parseUsd(bad)).toThrow();
  });
  it("converts cents for PayPal", () => {
    expect(centsToValue(1234)).toBe("12.34");
    expect(centsToValue(5)).toBe("0.05");
    expect(valueToCents("12.34")).toBe(1234);
    expect(() => valueToCents("0.005")).toThrow();
  });
});
