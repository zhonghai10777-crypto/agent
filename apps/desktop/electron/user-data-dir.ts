export function resolveProductUserDataDir(
  explicitPath: string | undefined,
  productPath: string,
  legacyPath: string,
  pathExists: (filePath: string) => boolean,
): string {
  const explicit = explicitPath?.trim();
  if (explicit) {
    return explicit;
  }
  return !pathExists(productPath) && pathExists(legacyPath) ? legacyPath : productPath;
}
