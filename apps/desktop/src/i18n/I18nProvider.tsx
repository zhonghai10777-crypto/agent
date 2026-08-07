import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { type Locale } from "./types";
import { createT, type Translator } from "./index";
import { formatRelativeTime } from "../string-utils";

interface I18nContextValue {
  readonly locale: Locale;
  readonly t: Translator;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Provides the active locale and a bound translator to the React tree. The
 * value is memoized on `locale`, so switching locale re-renders every consumer
 * without a reload.
 */
export function I18nProvider({ locale, children }: { readonly locale: Locale; readonly children: ReactNode }) {
  const value = useMemo<I18nContextValue>(() => ({ locale, t: createT(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error("useI18n must be used within an <I18nProvider>");
  }
  return value;
}

/**
 * Bound relative-time formatter for the current locale. Components can use this
 * instead of threading the locale into `formatRelativeTime` at every call site.
 */
export function useRelativeTime(): (value: string) => string {
  const { locale } = useI18n();
  return useCallback((value: string) => formatRelativeTime(value, locale), [locale]);
}
