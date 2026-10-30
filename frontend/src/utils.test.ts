import { describe, expect, it } from "vitest";
import {
  editorConfig,
  formatPercentage,
  newEditor,
  noteError,
  parseAllowlist,
  parsePercentage,
  parseRoute,
  sameConfig,
  subjectError,
} from "./utils";

describe("exact percentage handling", () => {
  it("converts decimal text to exact basis points without float rounding", () => {
    expect(parsePercentage("0.29")).toBe(29);
    expect(parsePercentage("99.99")).toBe(9999);
    expect(parsePercentage("100.00")).toBe(10000);
    expect(parsePercentage("12.5")).toBe(1250);
  });
  it("rejects ambiguous or out-of-range percentages rather than clamping", () => {
    for (const text of [
      "",
      "1.001",
      "100.01",
      "01",
      "1e2",
      " 25",
      ".5",
      "-1",
      "101",
      "1.",
      "NaN",
    ])
      expect(() => parsePercentage(text)).toThrow();
  });
  it("round-trips every valid basis-point integer", () => {
    for (let value = 0; value <= 10000; value++)
      expect(parsePercentage(formatPercentage(value))).toBe(value);
  });
});

describe("allowlist and note validation", () => {
  it("preserves ASCII subject case and sorts without merging distinct IDs", () => {
    expect(parseAllowlist("z-user\r\nA_user\r\na_user")).toEqual([
      "A_user",
      "a_user",
      "z-user",
    ]);
  });
  it("rejects duplicates, spaces, blank lines, non-ASCII and limit overflows", () => {
    for (const text of [
      "one\none",
      "one\n",
      "hello world",
      "é",
      "x".repeat(65),
      Array.from({ length: 21 }, (_, index) => `subject-${index}`).join("\n"),
    ])
      expect(() => parseAllowlist(text)).toThrow();
    expect(parseAllowlist("")).toEqual([]);
  });
  it("counts trimmed note Unicode codepoints instead of UTF-16 units", () => {
    expect(noteError(`  ${"😀".repeat(10)}  `)).toBeNull();
    expect(noteError("😀".repeat(9))).not.toBeNull();
    expect(noteError("😀".repeat(501))).not.toBeNull();
  });
  it("validates subject IDs with the same case-sensitive ASCII boundary", () => {
    expect(subjectError("A_b.C-12")).toBeNull();
    expect(subjectError("a".repeat(64))).toBeNull();
    for (const text of ["", " ", "ä", "two words", "x".repeat(65)])
      expect(subjectError(text)).not.toBeNull();
  });
});

describe("draft identity and navigation", () => {
  it("compares normalized allowlists while preserving distinct configurations", () => {
    const config = {
      enabled: true,
      rolloutBasisPoints: 29,
      allowlist: ["B", "a"],
    };
    expect(sameConfig(config, { ...config, allowlist: ["a", "B"] })).toBe(true);
    expect(sameConfig(config, { ...config, allowlist: ["b", "a"] })).toBe(
      false,
    );
    expect(editorConfig(newEditor(config))).toEqual(config);
  });
  it("parses only known environments and keeps direct links safe", () => {
    expect(parseRoute("#/flags/bulk-export/production")).toEqual({
      page: "detail",
      key: "bulk-export",
      environment: "production",
    });
    expect(parseRoute("#/flags/bulk-export/untrusted")).toEqual({
      page: "flags",
    });
    expect(parseRoute("#/playground")).toEqual({ page: "playground" });
  });
});
