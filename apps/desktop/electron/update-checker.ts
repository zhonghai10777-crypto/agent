import { app, net, Notification, shell } from "electron";
import { compare, parse } from "semver";
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
  prerelease?: boolean;
  assets?: readonly { name?: string; size?: number; state?: string; browser_download_url?: string }[];
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
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
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
    const current = options.currentVersion ?? app.getVersion();
    const currentParsed = strictVersion(current);
    if (!currentParsed) return { status: "error", code: "configuration", message: "The installed version is not valid SemVer." };
    const releases: GitHubRelease[] = [];
    // GitHub orders by publication, not version. Exhaust a bounded window; never
    // call an incomplete scan “up to date” or follow arbitrary Link URLs with auth.
    const pageSize = 30, maxPages = 5;
    let complete = false;
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetchRelease(`https://api.github.com/repos/${source.repository}/releases?per_page=${pageSize}&page=${page}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(source.token ? { Authorization: `Bearer ${source.token}` } : {}),
        },
        redirect: "error", signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) return { status: "error", code: "rate-limited", message: "GitHub's request limit was reached. Please try again later." };
        if ([401, 403, 404].includes(res.status)) return { status: "error", code: "access-denied", message: "The update repository is unavailable or requires access. Use your own read-only credential or ask the publisher for a public update source." };
        return { status: "error", code: "http", message: `The update service returned HTTP ${res.status}.` };
      }
      let payload: unknown;
      try { payload = await res.json(); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        return { status: "error", code: "invalid-response", message: "The update service returned an unreadable response." };
      }
      if (!Array.isArray(payload) || payload.length > pageSize) return { status: "error", code: "invalid-response", message: "The update service returned an unexpected response." };
      releases.push(...payload.filter((item): item is GitHubRelease => item && typeof item === "object" && !Array.isArray(item) && item.draft !== true));
      const link = res.headers.get("link");
      if (!(link ? /rel="next"/.test(link) : payload.length === pageSize)) { complete = true; break; }
    }
    if (!complete) return { status: "error", code: "incomplete-coverage", message: "More releases exist beyond the update check's 150-release window. View the release page or retry later; the latest compatible version could not be confirmed." };
    if (!releases.length) return { status: "error", code: "no-releases", message: "The update source has no published versions yet." };
    const valid = releases.flatMap((release) => {
      if (typeof release.tag_name !== "string") return [];
      const version = release.tag_name.replace(/^v/, "");
      const parsed = strictVersion(version);
      return parsed ? [{ release, version, parsed }] : [];
    });
    if (!valid.length) return { status: "error", code: "invalid-response", message: "The update service returned no valid versions." };
    const channel = currentParsed.prerelease[0];
    const candidates = valid.filter(({ release, parsed, version }) => {
      const stable = !parsed.prerelease.length && release.prerelease !== true;
      const permitted = stable || channel !== undefined && parsed.prerelease[0] === channel;
      return permitted && hasCompatibleAsset(release, version, source.repository, options.platform ?? process.platform, options.architecture ?? process.arch);
    }).sort((a, b) => compare(b.parsed, a.parsed));
    const latest = candidates[0];
    if (!latest) return { status: "error", code: "no-compatible-release", message: "The update source has no verified package for this platform, architecture and update channel." };
    if (compare(latest.parsed, currentParsed) > 0) return { status: "update-available", currentVersion: current, latestVersion: latest.version, releaseUrl: releaseUrlFor(latest.release, source.repository) };
    return { status: "up-to-date", currentVersion: current, latestVersion: latest.version };
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

/** Stable installs see stable releases; prerelease installs see their channel and stable releases. */
function strictVersion(version: string) {
  return /^\d/.test(version) && version.trim() === version ? parse(version) : null;
}

export function compareSemver(a: string, b: string): number {
  const left = strictVersion(a), right = strictVersion(b);
  return left && right ? compare(left, right) : 0;
}

export function hasCompatibleAsset(release: GitHubRelease, version: string, repository: string, platform: NodeJS.Platform, architecture: string): boolean {
  if (!release.tag_name || !Array.isArray(release.assets)) return false;
  const stem = `Agent-${version}-${architecture}`;
  const names = platform === "win32" ? [`${stem}-setup.exe`, `${stem}-portable.exe`]
    : platform === "darwin" ? [`${stem}.dmg`, `${stem}.zip`, `Agent-${version}-universal.dmg`, `Agent-${version}-universal.zip`]
    : platform === "linux" ? [`${stem}.AppImage`, `Agent_${version}_${architecture}.deb`] : [];
  return release.assets.some((asset) => {
    if (!asset || !names.includes(asset.name ?? "") || !(typeof asset.size === "number" && asset.size > 0) || asset.state !== "uploaded") return false;
    try {
      const url = new URL(asset.browser_download_url ?? "");
      const expected = new URL(`https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name!)}/${encodeURIComponent(asset.name!)}`);
      return url.href === expected.href;
    } catch { return false; }
  });
}
