import { useEffect, useState } from "react";
import type { Translator } from "../i18n";

export function useRunningLabel(startedAt: string | undefined, t: Translator) {
  const [label, setLabel] = useState(() => formatRunningLabel(startedAt, t));

  useEffect(() => {
    setLabel(formatRunningLabel(startedAt, t));
    if (!startedAt) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      setLabel(formatRunningLabel(startedAt, t));
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [startedAt, t]);

  return label;
}

function formatRunningLabel(startedAt: string | undefined, t: Translator): string {
  if (!startedAt) {
    return t("running.working");
  }

  const diffMs = Math.max(0, Date.now() - Date.parse(startedAt));
  const seconds = Math.max(1, Math.floor(diffMs / 1000));
  if (seconds < 60) {
    return t("running.forSeconds", { seconds });
  }

  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0
    ? t("running.forMinutes", { minutes })
    : t("running.forMinutesSeconds", { minutes, seconds: remaining });
}
