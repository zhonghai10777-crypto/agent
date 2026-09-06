import { app, net, Notification, shell } from "electron";
import { PRODUCT, PRODUCT_UPDATE_REPOSITORY } from "../src/product";
import type { UpdateCheckResult } from "../src/update-state";
export type { UpdateCheckResult } from "../src/update-state";

const BUNDLED_UPDATE_REPOSITORY = process.env.PI_APP_BUILD_UPDATE_REPOSITORY || PRODUCT_UPDATE_REPOSITORY;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_DELAY_MS = 15_000; // 15 seconds after launch
const FETCH_TIMEOUT_MS = 10_000; // give up on a hung request

export interface UpdateSource {
  readonly repository: string;
  readonly token?: string;
}

export function resolveUpdateSource(env: NodeJS.ProcessEnv = process.env): UpdateSource {
  const repository = env.PI_APP_UPDATE_REPOSITORY?.trim() || BUNDLED_UPDATE_REPOSITORY;
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository) || [".", ".."].includes(repository.split("/")[1]!)) {
    throw new Error("The update repository must use the owner/repository format.");
  }
  const token = env.PI_APP_UPDATE_TOKEN?.trim();
  if (token && /[\r\n]/.test(token)) throw new Error("The update credential is invalid.");
  return { repository, ...(token ? { token } : {}) };
}

const releasesPageFor = (repository: string) => `https://github.com/${repository}/releases`;

export type GitHubRelease = {
  tag_name?: string;
  html_url?: string;
  draft?: boolean;
};

export function openReleasesPage(releaseUrl = releasesPageFor(resolveUpdateSource().repository)): Promise<void> {
  return shell.openExternal(releaseUrl);
}

export function showUpdateNotification(
  currentVersion: string,
  latestVersion: string,
  releaseUrl: string,
): void {
  if (!Notification.isSupported()) {
    return;
  }
  const notification = new Notification({
    title: `${PRODUCT.name} update available`,
    body: `Version ${latestVersion} is available (you have ${currentVersion}). Click to view the release.`,
  });
  notification.on("click", () => {
    void openReleasesPage(releaseUrl);
  });
  notification.show();
}

/**
 * Pure update check — performs the network request and version comparison but
 * never shows UI. Callers decide how to surface the result (auto path shows a
 * deduped notification, the manual menu path shows a dialog).
 */
interface UpdateCheckOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly currentVersion?: string;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  let source: UpdateSource;
  try {
    source = resolveUpdateSource(options.env);
  } catch (error) {
    return { status: "error", code: "configuration", message: (error as Error).message };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const fetchRelease = options.fetch ?? ((url, init) => net.fetch(url, init));
  try {
    const res = await fetchRelease(`https://api.github.com/repos/${source.repository}/releases?per_page=10`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(source.token ? { Authorization: `Bearer ${source.token}` } : {}),
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
        return { status: "error", code: "rate-limited", message: "GitHub's request limit was reached. Please try again later." };
      }
      if ([401, 403, 404].includes(res.status)) {
        return { status: "error", code: "access-denied", message: "The update repository is unavailable or requires access. Use your own read-only credential or ask the publisher for a public update source." };
      }
      return { status: "error", code: "http", message: `The update service returned HTTP ${res.status}.` };
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      return { status: "error", code: "invalid-response", message: "The update service returned an unreadable response." };
    }
    if (!Array.isArray(payload)) {
      return { status: "error", code: "invalid-response", message: "The update service returned an unexpected response." };
    }
    const release = payload.find((item): item is GitHubRelease & { tag_name: string } =>
      typeof item === "object" && item !== null && item.draft !== true && typeof item.tag_name === "string");
    if (!release) {
      return { status: "error", code: "no-releases", message: "The update source has no published versions yet." };
    }
    const latest = release.tag_name.replace(/^v/, "");
    const current = options.currentVersion ?? app.getVersion();
    if (!parseSemver(latest) || !parseSemver(current)) {
      return { status: "error", code: "invalid-response", message: "The update service returned an invalid version." };
    }
    if (compareSemver(latest, current) > 0) {
      return { status: "update-available", currentVersion: current, latestVersion: latest, releaseUrl: releaseUrlFor(release, source.repository) };
    }
    return { status: "up-to-date", currentVersion: current, latestVersion: latest };
  } catch {
    return {
      status: "error",
      code: controller.signal.aborted ? "timeout" : "network",
      message: controller.signal.aborted ? "The update check timed out." : "Could not reach the update service. Please check your connection.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function initUpdateChecker(): () => void {
  // Dedupe notifications per version so a still-unactioned update doesn't
  // re-notify on every 4-hour poll.
  let lastNotifiedVersion: string | undefined;
  const runAutoCheck = async () => {
    const result = await checkForUpdate();
    if (result.status === "error") {
      console.warn("Update check failed:", result.message);
      return;
    }
    if (result.status === "update-available" && result.latestVersion !== lastNotifiedVersion) {
      lastNotifiedVersion = result.latestVersion;
      showUpdateNotification(result.currentVersion, result.latestVersion, result.releaseUrl);
    }
  };

  const timeout = setTimeout(() => void runAutoCheck(), INITIAL_DELAY_MS);
  const interval = setInterval(() => void runAutoCheck(), CHECK_INTERVAL_MS);

  return () => {
    clearTimeout(timeout);
    clearInterval(interval);
  };
}

export function releaseUrlFor(release: GitHubRelease, repository = resolveUpdateSource().repository): string {
  const releasesPage = releasesPageFor(repository);
  const tag = release.tag_name;
  if (!tag) {
    return releasesPage;
  }

  const canonicalUrl = `${releasesPage}/tag/${encodeURIComponent(tag)}`;
  if (!release.html_url) {
    return canonicalUrl;
  }

  try {
    const candidate = new URL(release.html_url);
    const canonical = new URL(canonicalUrl);
    if (
      candidate.protocol === canonical.protocol &&
      candidate.host === canonical.host &&
      candidate.pathname === canonical.pathname &&
      candidate.username === "" &&
      candidate.password === "" &&
      candidate.search === "" &&
      candidate.hash === ""
    ) {
      return candidate.toString();
    }
  } catch {
    // Fall through to the repository's canonical URL for this exact tag.
  }
  return canonicalUrl;
}

/**
 * Compare two semver strings. Returns a negative number when `a < b`, zero when
 * equal, positive when `a > b`. Handles prerelease precedence per semver
 * (a release outranks its own prereleases); unparseable inputs compare equal so
 * we never claim an update we can't verify.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    return 0;
  }
  if (pa.nums[0] !== pb.nums[0]) {
    return pa.nums[0] < pb.nums[0] ? -1 : 1;
  }
  if (pa.nums[1] !== pb.nums[1]) {
    return pa.nums[1] < pb.nums[1] ? -1 : 1;
  }
  if (pa.nums[2] !== pb.nums[2]) {
    return pa.nums[2] < pb.nums[2] ? -1 : 1;
  }
  return comparePrerelease(pa.pre, pb.pre);
}

function parseSemver(version: string): { nums: [number, number, number]; pre: string[] } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  // A version without a prerelease tag has higher precedence than one with it.
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? "";
    const right = b[index] ?? "";
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right);
      if (delta !== 0) {
        return delta < 0 ? -1 : 1;
      }
    } else if (leftNumeric) {
      return -1; // numeric identifiers rank lower than alphanumeric
    } else if (rightNumeric) {
      return 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
}
