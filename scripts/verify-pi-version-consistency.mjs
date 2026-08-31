import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const APPROVED_VERSION = "0.84.4";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopPackagePath = path.join(repoDir, "apps", "desktop", "package.json");
const driverPackagePath = path.join(repoDir, "packages", "pi-sdk-driver", "package.json");
const lockfilePath = path.join(repoDir, "pnpm-lock.yaml");
const requireFromDesktop = createRequire(desktopPackagePath);
const { parse } = requireFromDesktop("yaml");

const [desktopPackage, driverPackage, lockfileText] = await Promise.all([
  readJson(desktopPackagePath),
  readJson(driverPackagePath),
  readFile(lockfilePath, "utf8"),
]);
const lockfile = parse(lockfileText);

assertDeclaredVersion(desktopPackage, "apps/desktop/package.json");
assertDeclaredVersion(driverPackage, "packages/pi-sdk-driver/package.json");
assertLockedImporter(lockfile, "apps/desktop");
assertLockedImporter(lockfile, "packages/pi-sdk-driver");

const lockedRuntimeVersions = new Set();
for (const sectionName of ["packages", "snapshots"]) {
  const section = lockfile?.[sectionName];
  if (!section || typeof section !== "object") continue;
  for (const key of Object.keys(section)) {
    const version = packageVersionFromLockKey(key, PI_PACKAGE);
    if (version) lockedRuntimeVersions.add(version);
  }
}

if (lockedRuntimeVersions.size !== 1 || !lockedRuntimeVersions.has(APPROVED_VERSION)) {
  fail(
    `pnpm-lock.yaml must contain exactly ${PI_PACKAGE} ${APPROVED_VERSION}; found ${
      [...lockedRuntimeVersions].sort().join(", ") || "none"
    }`,
  );
}

console.log(`Verified ${PI_PACKAGE} is consistently pinned to ${APPROVED_VERSION}.`);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assertDeclaredVersion(packageJson, label) {
  const declared = packageJson?.dependencies?.[PI_PACKAGE];
  if (declared !== APPROVED_VERSION) {
    fail(`${label} must declare ${PI_PACKAGE} as exact version ${APPROVED_VERSION}; found ${String(declared)}`);
  }
}

function assertLockedImporter(lockfileValue, importerName) {
  const dependency = lockfileValue?.importers?.[importerName]?.dependencies?.[PI_PACKAGE];
  const resolved = typeof dependency?.version === "string" ? dependency.version.split("(", 1)[0] : undefined;
  if (dependency?.specifier !== APPROVED_VERSION || resolved !== APPROVED_VERSION) {
    fail(
      `pnpm-lock.yaml importer ${importerName} must resolve ${PI_PACKAGE} ${APPROVED_VERSION}; found specifier ${String(
        dependency?.specifier,
      )}, version ${String(dependency?.version)}`,
    );
  }
}

function packageVersionFromLockKey(key, packageName) {
  const prefix = `${packageName}@`;
  if (!key.startsWith(prefix)) return undefined;
  return key.slice(prefix.length).split("(", 1)[0];
}

function fail(message) {
  throw new Error(message);
}
