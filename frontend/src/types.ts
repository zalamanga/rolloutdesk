export type Environment = "staging" | "production";
export const environments: Environment[] = ["staging", "production"];
export const flagKeys = [
  "checkout-redesign",
  "bulk-export",
  "priority-support",
] as const;
export type Config = {
  enabled: boolean;
  rolloutBasisPoints: number;
  allowlist: string[];
};
export type User = { id: string; email: string; name: string };
export type Session = { user: User; csrfToken: string };
export type Publication = {
  revision: number;
  config: Config;
  kind: "PUBLISH" | "ROLLBACK";
  sourceRevision: number | null;
  note: string;
  actor: string;
  createdAt: string;
};
export type EnvironmentState = {
  environment: Environment;
  version: number;
  draft: Config;
  active: Publication | null;
  updatedAt: string;
};
export type Flag = {
  key: string;
  name: string;
  description: string;
  states: EnvironmentState[];
};
export type FlagDetail = {
  flag: Pick<Flag, "key" | "name" | "description">;
  state: EnvironmentState;
  history: Publication[];
};
export type Decision = {
  flagKey: string;
  environment: Environment;
  revision: number | null;
  value: boolean;
  reason:
    | "DISABLED"
    | "ALLOWLIST"
    | "ROLLOUT"
    | "OUTSIDE_ROLLOUT"
    | "UNPUBLISHED"
    | "FLAG_NOT_FOUND";
  bucket: number | null;
  algorithm: "sha256-u32be-mod10000-v1";
};
export type Preview = { published: Decision; draft: Decision };
export type AuditItem = {
  id: string;
  createdAt: string;
  actor: string;
  action: "DRAFT_SAVED" | "PUBLISHED" | "ROLLED_BACK";
  flagKey: string;
  environment: Environment;
  revision: number | null;
  note: string;
};
export type Page<T> = { items: T[]; page: number; pageSize: 25; total: number };
