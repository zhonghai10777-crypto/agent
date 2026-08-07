import { DEFAULT_LOCALE, isLocale, type Locale } from "../desktop-state";
import enMessages, { type MessageKey } from "./en";
import zhMessages from "./zh";

export type { Locale, MessageKey };

/** Parameters for message interpolation, e.g. `{ name }` → `{ name }` value. */
export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * Resolve the message dictionary for a locale. Unsupported/unknown locales
 * fall back to English (the default).
 */
export function getDictionary(locale: Locale): Readonly<Record<MessageKey, string>> {
  switch (locale) {
    case "zh-CN":
      return zhMessages;
    case "en":
    default:
      return enMessages;
  }
}

/**
 * Interpolate `{param}` placeholders in a template string. Unknown placeholders
 * (e.g. the English plural `{s}` marker) are left literally so Chinese
 * translations that omit them are unaffected.
 */
function interpolate(template: string, params: MessageParams | undefined): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * Translate a message key for a locale. Falls back to English, then to the raw
 * key, when a translation is missing, so a typo never crashes the UI.
 */
export function t(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const dictionary = getDictionary(locale);
  const template = dictionary[key] ?? enMessages[key] ?? key;
  return interpolate(template, params);
}

/** Create a bound translator for a fixed locale. */
export type Translator = (key: MessageKey, params?: MessageParams) => string;

export function createT(locale: Locale): Translator {
  return (key, params) => t(locale, key, params);
}

/**
 * ── Main-process helpers ─────────────────────────────
 *
 * The main process builds its own strings (notifications, menu, dialogs,
 * timeline labels). The store sets the global locale via `setGlobalLocale`
 * during initialize() and on every `setLocale`; modules call `tGlobal` for
 * current-locale strings. The renderer should use the React context `t`
 * instead of `tGlobal` to avoid multi-window desync.
 */
let globalLocale: Locale = DEFAULT_LOCALE;

export function setGlobalLocale(locale: Locale): void {
  globalLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;
}

export function getGlobalLocale(): Locale {
  return globalLocale;
}

export function tGlobal(key: MessageKey, params?: MessageParams): string {
  return t(globalLocale, key, params);
}
