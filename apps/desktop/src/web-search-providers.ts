/**
 * Search-backend identity, shared by both processes.
 *
 * These used to be defined twice — once in `electron/web-search.ts`, once in
 * `src/ipc.ts` — kept in step by a "Mirrors …" comment. The stated reason (the
 * renderer cannot import from the main process) does not apply in this
 * direction: `tsconfig.electron.json` includes `src/**` and `electron/` already
 * imports from `../src/` throughout, `web-search.ts` itself taking
 * `../src/product`. So the facts live here once, and the DeepSeek special case
 * below is asserted in exactly one place.
 */

export type WebSearchProvider = "deepseek" | "bocha" | "tavily" | "searxng";

/** Every valid provider, in the order the settings dropdown offers them. */
export const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[] = ["deepseek", "bocha", "tavily", "searxng"];

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return typeof value === "string" && (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Backends that can fall back to the user's DeepSeek *model* credential when no
 * key is typed into the web-access settings, so a user who already configured
 * DeepSeek is not asked for the same secret twice.
 *
 * A key entered under Settings → Web access still wins: it is the only one the
 * UI can show and change, and on a fresh install it may be the only one that
 * exists.
 *
 * DeepSeek is the only entry because it is the only search backend whose vendor
 * is also a model provider pi holds a credential for — bocha and tavily are
 * search-only, and searxng needs no key at all.
 */
export function canBorrowModelProviderKey(provider: WebSearchProvider): boolean {
  return provider === "deepseek";
}

/**
 * Which credential search will actually use.
 *
 * One tri-state rather than a `hasApiKey`/`hasBorrowedProviderKey` pair: the
 * pair admits a fourth, meaningless combination and made the renderer re-derive
 * the precedence rule that the main process had already applied.
 */
export type WebSearchKeySource = "stored" | "borrowed" | "none";
