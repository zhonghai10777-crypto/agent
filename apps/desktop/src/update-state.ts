export type UpdateCheckErrorCode =
  | "configuration"
  | "access-denied"
  | "network"
  | "timeout"
  | "rate-limited"
  | "invalid-response"
  | "no-releases"
  | "http";

export type UpdateCheckResult =
  | { status: "up-to-date"; currentVersion: string; latestVersion: string }
  | { status: "update-available"; currentVersion: string; latestVersion: string; releaseUrl: string }
  | { status: "error"; code: UpdateCheckErrorCode; message: string };
