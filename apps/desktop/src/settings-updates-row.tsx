import { useState } from "react";
import type { MessageKey } from "./i18n";
import { useI18n } from "./i18n/I18nProvider";
import { SettingsRow, settingsPill } from "./settings-utils";
import type { UpdateCheckErrorCode, UpdateCheckResult } from "./update-state";

const errorKeys: Record<UpdateCheckErrorCode, MessageKey> = {
  configuration: "settings.updates.configuration",
  "access-denied": "settings.updates.accessDenied",
  network: "settings.updates.network",
  timeout: "settings.updates.timeout",
  "rate-limited": "settings.updates.rateLimited",
  "invalid-response": "settings.updates.invalidResponse",
  "no-releases": "settings.updates.noReleases",
  http: "settings.updates.serviceError",
};

export function SettingsUpdatesRow() {
  const { t } = useI18n();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult>();
  const check = async () => {
    setChecking(true);
    setResult(undefined);
    try {
      const next = await window.piApp?.checkForUpdates();
      if (!next) throw new Error("Update service unavailable");
      setResult(next);
    } catch {
      setResult({ status: "error", code: "network", message: "" });
    } finally {
      setChecking(false);
    }
  };

  return (
    <SettingsRow className="settings-row--updates" title={t("settings.updates.title")} description={t("settings.updates.description")}>
      <div className="settings-pill-row">
        <button type="button" className={settingsPill(false)} disabled={checking} onClick={() => void check()}>
          {t(checking ? "settings.updates.checking" : "settings.updates.check")}
        </button>
        {result?.status === "update-available" ? (
          <a className={settingsPill(false)} href={result.releaseUrl} target="_blank" rel="noreferrer">
            {t("settings.updates.download")}
          </a>
        ) : null}
      </div>
      {result ? (
        <p role="status" data-testid="update-check-status" className="settings-inline-note">
          {result.status === "error"
            ? t(errorKeys[result.code])
            : t(result.status === "up-to-date" ? "settings.updates.current" : "settings.updates.available", {
                version: result.status === "up-to-date" ? result.currentVersion : result.latestVersion,
              })}
        </p>
      ) : null}
    </SettingsRow>
  );
}
