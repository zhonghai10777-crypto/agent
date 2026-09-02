import { useEffect, useState } from "react";
import {
  WEB_SEARCH_PROVIDERS,
  webSearchUsesModelProviderKey,
  type WebSearchProvider,
  type WebToolsSettingsView,
} from "./ipc";
import { useI18n } from "./i18n/I18nProvider";
import { SettingsGroup, SettingsRow } from "./settings-utils";

/** Placeholder shown in the key field once a key is stored, so the real secret never reaches the renderer. */
const STORED_KEY_MASK = "••••••••••••";

export function SettingsWebSection() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<WebToolsSettingsView | undefined>();
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [domainsDraft, setDomainsDraft] = useState("");
  const [searxngDraft, setSearxngDraft] = useState("");
  const [status, setStatus] = useState<{ readonly kind: "ok" | "error"; readonly text: string } | undefined>();
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let active = true;
    void window.piApp?.getWebToolsSettings().then((loaded) => {
      if (!active) {
        return;
      }
      setSettings(loaded);
      setSearxngDraft(loaded.searxngBaseUrl);
      setDomainsDraft(loaded.allowedDomains.join(", "));
      setApiKeyDraft(loaded.hasApiKey ? STORED_KEY_MASK : "");
    });
    return () => {
      active = false;
    };
  }, []);

  if (!settings) {
    return null;
  }

  const save = async (patch: Partial<WebToolsSettingsView> & { readonly apiKey?: string }) => {
    const next = await window.piApp?.setWebToolsSettings({
      enabled: patch.enabled ?? settings.enabled,
      provider: patch.provider ?? settings.provider,
      searxngBaseUrl: patch.searxngBaseUrl ?? settings.searxngBaseUrl,
      maxResults: patch.maxResults ?? settings.maxResults,
      allowedDomains: patch.allowedDomains ?? settings.allowedDomains,
      // Sending the mask back would overwrite the real key with dots, so only
      // send a key the user actually typed.
      ...(patch.apiKey !== undefined && patch.apiKey !== STORED_KEY_MASK ? { apiKey: patch.apiKey } : {}),
    });
    if (next) {
      setSettings(next);
      if (next.hasApiKey && apiKeyDraft !== STORED_KEY_MASK && patch.apiKey) {
        setApiKeyDraft(STORED_KEY_MASK);
      }
    }
    return next;
  };

  const runTest = async () => {
    setTesting(true);
    setStatus(undefined);
    try {
      const result = await window.piApp?.testWebSearch(t("web.testQuery"));
      if (!result) {
        return;
      }
      setStatus(
        result.ok
          ? { kind: "ok", text: t("web.testOk", { count: result.resultCount }) }
          : { kind: "error", text: result.error },
      );
    } finally {
      setTesting(false);
    }
  };

  // DeepSeek borrows the model credential, so there is no key to type here and
  // no SearXNG address to fill in either.
  const usesProviderKey = webSearchUsesModelProviderKey(settings.provider);
  const needsApiKey = !usesProviderKey && settings.provider !== "searxng";

  return (
    <>
      <SettingsGroup title={t("web.groupTitle")} description={t("web.groupDesc")}>
        <SettingsRow title={t("web.enable")} description={t("web.enableDesc")}>
          <input
            aria-label={t("web.enable")}
            checked={settings.enabled}
            type="checkbox"
            onChange={(event) => void save({ enabled: event.target.checked })}
          />
        </SettingsRow>

        <SettingsRow title={t("web.provider")} description={t("web.providerDesc")}>
          <select
            aria-label={t("web.provider")}
            value={settings.provider}
            onChange={(event) => void save({ provider: event.target.value as WebSearchProvider })}
          >
            {WEB_SEARCH_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {t(`web.provider.${provider}`)}
              </option>
            ))}
          </select>
        </SettingsRow>

        {usesProviderKey ? (
          <SettingsRow title={t("web.boundKey")} description={t("web.boundKeyDesc")}>
            <span className={settings.hasApiKey ? "settings-status--ok" : "settings-status--error"}>
              {settings.hasApiKey ? t("web.boundKeyReady") : t("web.boundKeyMissing")}
            </span>
          </SettingsRow>
        ) : needsApiKey ? (
          <SettingsRow title={t("web.apiKey")} description={t("web.apiKeyDesc")}>
            <input
              aria-label={t("web.apiKey")}
              type="password"
              value={apiKeyDraft}
              placeholder={t("web.apiKeyPlaceholder")}
              onChange={(event) => setApiKeyDraft(event.target.value)}
              onBlur={() => {
                if (apiKeyDraft !== STORED_KEY_MASK) {
                  void save({ apiKey: apiKeyDraft.trim() });
                }
              }}
            />
          </SettingsRow>
        ) : (
          <SettingsRow title={t("web.searxngUrl")} description={t("web.searxngUrlDesc")}>
            <input
              aria-label={t("web.searxngUrl")}
              type="text"
              value={searxngDraft}
              placeholder="http://searxng.example.com"
              onChange={(event) => setSearxngDraft(event.target.value)}
              onBlur={() => void save({ searxngBaseUrl: searxngDraft.trim() })}
            />
          </SettingsRow>
        )}

        <SettingsRow title={t("web.maxResults")} description={t("web.maxResultsDesc")}>
          <input
            aria-label={t("web.maxResults")}
            type="number"
            min={1}
            max={20}
            value={settings.maxResults}
            onChange={(event) => {
              const value = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(value)) {
                void save({ maxResults: value });
              }
            }}
          />
        </SettingsRow>

        <SettingsRow title={t("web.test")} description={t("web.testDesc")}>
          <div className="settings-inline">
            <button className="button" type="button" disabled={testing} onClick={() => void runTest()}>
              {testing ? t("web.testing") : t("web.testButton")}
            </button>
            {status ? (
              <span className={status.kind === "ok" ? "settings-status--ok" : "settings-status--error"}>
                {status.text}
              </span>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("web.securityTitle")} description={t("web.securityDesc")}>
        <SettingsRow title={t("web.allowedDomains")} description={t("web.allowedDomainsDesc")}>
          <input
            aria-label={t("web.allowedDomains")}
            type="text"
            value={domainsDraft}
            placeholder={t("web.allowedDomainsPlaceholder")}
            onChange={(event) => setDomainsDraft(event.target.value)}
            onBlur={() =>
              void save({
                allowedDomains: domainsDraft
                  .split(/[,，\s]+/)
                  .map((entry) => entry.trim())
                  .filter(Boolean),
              })
            }
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
