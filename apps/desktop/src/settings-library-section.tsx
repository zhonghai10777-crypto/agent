import { useEffect, useState } from "react";
import type {
  LibraryIndexStatusView,
  LibrarySettingsView,
  LibrarySkipReasonView,
} from "./ipc";
import { CloseIcon, FolderIcon, RefreshIcon } from "./icons";
import type { Translator } from "./i18n";
import { useI18n } from "./i18n/I18nProvider";
import { SettingsGroup, SettingsRow } from "./settings-utils";

export function SettingsLibrarySection() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<LibrarySettingsView>();
  const [status, setStatus] = useState<LibraryIndexStatusView>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const next = await window.piApp?.getLibraryIndexStatus();
      if (active && next) {
        setStatus(next);
      }
    };
    void Promise.all([window.piApp?.getLibrarySettings(), window.piApp?.getLibraryIndexStatus()]).then(
      ([nextSettings, nextStatus]) => {
        if (!active) {
          return;
        }
        if (nextSettings) {
          setSettings(nextSettings);
        }
        if (nextStatus) {
          setStatus(nextStatus);
        }
      },
    );
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!settings || !status) {
    return null;
  }

  const save = async (next: LibrarySettingsView) => {
    setPending(true);
    setError("");
    try {
      const saved = await window.piApp?.setLibrarySettings(next);
      if (saved) {
        setSettings(saved);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const addRoot = async () => {
    const root = await window.piApp?.pickLibraryRoot();
    if (!root || settings.roots.includes(root)) {
      return;
    }
    await save({ ...settings, roots: [...settings.roots, root] });
  };

  const rebuild = async () => {
    setPending(true);
    setError("");
    try {
      const next = await window.piApp?.rebuildLibraryIndex();
      if (next) {
        setStatus(next);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <SettingsGroup title={t("library.groupTitle")} description={t("library.groupDesc")}>
        <SettingsRow title={t("library.enable")} description={t("library.enableDesc")}>
          <input
            aria-label={t("library.enable")}
            checked={settings.enabled}
            disabled={pending}
            type="checkbox"
            onChange={(event) => void save({ ...settings, enabled: event.target.checked })}
          />
        </SettingsRow>

        <SettingsRow title={t("library.folders")} description={t("library.foldersDesc")}>
          <button
            className="button button--secondary library-action"
            disabled={pending}
            type="button"
            onClick={() => void addRoot()}
          >
            <FolderIcon />
            {t("library.addFolder")}
          </button>
        </SettingsRow>

        {settings.roots.length > 0 ? (
          <div className="library-list" aria-label={t("library.folders")}>
            {settings.roots.map((root) => (
              <div className="settings-list__row" key={root}>
                <div className="settings-list__body">
                  <div className="settings-list__title">{fileName(root)}</div>
                  <div className="settings-list__meta">{root}</div>
                </div>
                <button
                  className="icon-button library-remove"
                  disabled={pending}
                  type="button"
                  title={t("library.removeFolder", { name: fileName(root) })}
                  aria-label={t("library.removeFolder", { name: fileName(root) })}
                  onClick={() => void save({ ...settings, roots: settings.roots.filter((entry) => entry !== root) })}
                >
                  <CloseIcon />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="library-empty">{t("library.noFolders")}</div>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("library.statusTitle")} description={t("library.statusDesc")}>
        <SettingsRow title={statusText(status, t)} description={error || undefined}>
          <button
            className="button button--secondary library-action"
            disabled={!settings.enabled || pending || settings.roots.length === 0 || status.state === "indexing"}
            type="button"
            onClick={() => void rebuild()}
          >
            <RefreshIcon />
            {t("library.rebuild")}
          </button>
        </SettingsRow>

        {status.skipped.length > 0 ? (
          <div className="library-skipped">
            <div className="library-skipped__heading">{t("library.skippedTitle")}</div>
            <div className="settings-list">
              {status.skipped.map((entry) => (
                <div className="settings-list__row" key={`${entry.path}:${entry.reasonCode}`}>
                  <div className="settings-list__body">
                    <div className="settings-list__title">{fileName(entry.path)}</div>
                    <div className="settings-list__meta">{entry.path}</div>
                    <div className="library-skipped__reason">{skipReason(entry.reasonCode, t)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </SettingsGroup>
    </>
  );
}

function statusText(status: LibraryIndexStatusView, t: Translator): string {
  switch (status.state) {
    case "indexing":
      return t("library.statusIndexing", { done: status.done, total: status.total });
    case "ready":
      return t("library.statusReady", { documents: status.documents, parts: status.parts });
    default:
      return t("library.statusIdle");
  }
}

function skipReason(reason: LibrarySkipReasonView, t: Translator): string {
  switch (reason) {
    case "scanned-pdf":
      return t("library.skip.scanned-pdf");
    case "password-protected":
      return t("library.skip.password-protected");
    case "corrupt":
      return t("library.skip.corrupt");
    case "too-large":
      return t("library.skip.too-large");
    case "empty":
      return t("library.skip.empty");
    case "unsupported":
      return t("library.skip.unsupported");
    case "capacity":
      return t("library.skip.capacity");
    default:
      return t("library.skip.unavailable");
  }
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}
