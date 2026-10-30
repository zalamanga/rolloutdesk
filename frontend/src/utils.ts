import type { Config, Environment } from "./types";

export type Editor = {
  enabled: boolean;
  percentage: string;
  allowlist: string;
  publishNote: string;
  rollbackNote: string;
  targetRevision: string;
};

export function formatPercentage(basisPoints: number): string {
  return `${Math.floor(basisPoints / 100)}${
    basisPoints % 100
      ? `.${String(basisPoints % 100)
          .padStart(2, "0")
          .replace(/0$/, "")}`
      : ""
  }`;
}

export function parsePercentage(text: string): number {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(text)) {
    throw new Error(
      "Enter a percentage from 0 to 100 with at most two decimal places.",
    );
  }
  const [whole, decimals = ""] = text.split(".");
  const value = Number(whole) * 100 + Number(decimals.padEnd(2, "0"));
  if (value > 10_000) throw new Error("The percentage cannot exceed 100.");
  return value;
}

export function parseAllowlist(text: string): string[] {
  if (text === "" || text.trim() === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 20)
    throw new Error("Use at most 20 subjects, one per line.");
  const found = new Set<string>();
  for (const line of lines) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(line)) {
      throw new Error(
        "Each subject must use 1 to 64 ASCII letters, digits, dots, underscores or hyphens. Remove blank lines and spaces.",
      );
    }
    if (found.has(line))
      throw new Error(
        "Each subject may appear only once. Subject IDs are case sensitive.",
      );
    found.add(line);
  }
  return [...found].sort();
}

export function editorConfig(editor: Editor): Config {
  return {
    enabled: editor.enabled,
    rolloutBasisPoints: parsePercentage(editor.percentage),
    allowlist: parseAllowlist(editor.allowlist),
  };
}

export function newEditor(config: Config): Editor {
  return {
    enabled: config.enabled,
    percentage: formatPercentage(config.rolloutBasisPoints),
    allowlist: config.allowlist.join("\n"),
    publishNote: "",
    rollbackNote: "",
    targetRevision: "",
  };
}

export function sameConfig(a: Config, b: Config): boolean {
  return (
    a.enabled === b.enabled &&
    a.rolloutBasisPoints === b.rolloutBasisPoints &&
    [...a.allowlist].sort().join("\n") === [...b.allowlist].sort().join("\n")
  );
}

export function noteError(text: string): string | null {
  const length = [...text.trim()].length;
  return length < 10 || length > 500
    ? "Write a note of 10 to 500 characters after trimming."
    : null;
}

export function subjectError(text: string): string | null {
  return /^[A-Za-z0-9._-]{1,64}$/.test(text)
    ? null
    : "Use 1 to 64 ASCII letters, digits, dots, underscores or hyphens.";
}

export function displayTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export type Route =
  | { page: "flags" | "playground" | "audit" }
  | { page: "detail"; key: string; environment: Environment };
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (
    parts[0] === "flags" &&
    parts.length === 3 &&
    /^(staging|production)$/.test(parts[2]) &&
    /^[a-z0-9-]+$/.test(parts[1])
  ) {
    return {
      page: "detail",
      key: parts[1],
      environment: parts[2] as Environment,
    };
  }
  return {
    page:
      parts[0] === "playground"
        ? "playground"
        : parts[0] === "audit"
          ? "audit"
          : "flags",
  };
}
