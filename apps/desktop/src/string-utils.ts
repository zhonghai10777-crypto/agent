import { DEFAULT_LOCALE, type Locale } from "./desktop-state";
import { t } from "./i18n";

export function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatRelativeTime(value: string, locale: Locale = DEFAULT_LOCALE): string {
  if (!value) {
    return "";
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
  if (diffMinutes < 1) return t(locale, "time.now");
  if (diffMinutes < 60) return t(locale, "time.minute", { n: diffMinutes });
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return t(locale, "time.hour", { n: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return t(locale, "time.day", { n: diffDays });
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffDays < 30) return t(locale, "time.week", { n: diffWeeks });
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return t(locale, "time.month", { n: diffMonths });
  const diffYears = Math.floor(diffDays / 365);
  return t(locale, "time.year", { n: diffYears });
}
