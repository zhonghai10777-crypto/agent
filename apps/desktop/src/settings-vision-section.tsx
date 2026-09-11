import { useEffect, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { VisionRoutingSettings } from "@pi-gui/session-driver/vision-types";
import { useI18n } from "./i18n/I18nProvider";
import { SettingsGroup, SettingsRow } from "./settings-utils";

export function SettingsVisionSection({ runtime }: { readonly runtime?: RuntimeSnapshot }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<VisionRoutingSettings>();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState("");
  const candidates = runtime?.models.filter((model) => !model.supportsImages && ["deepseek-v4-pro", "deepseek-v4-flash"].includes(model.modelId)) ?? [];
  const selected = candidates.find((model) => `${model.providerId}/${model.modelId}` === selection) ?? candidates[0];
  useEffect(() => {
    let active = true;
    void window.piApp?.getVisionSettings().then((value) => { if (active) setSettings(value); }).catch(() => { if (active) setStatus(t("vision.storageError")); });
    return () => { active = false; };
  }, [t]);
  const save = async (enabled: boolean) => {
    const previous = settings;
    if (previous) setSettings({ ...previous, enabled });
    setBusy(true);
    try { setSettings(await window.piApp!.setVisionEnabled(enabled)); setStatus(undefined); }
    catch { setSettings(previous); setStatus(t("vision.storageError")); }
    finally { setBusy(false); }
  };
  const test = async (performRequest: boolean) => {
    if (!selected) return;
    setBusy(true);
    setStatus(undefined);
    try {
      const result = await window.piApp!.testVisionConnection({ provider: selected.providerId, modelId: selected.modelId, performRequest });
      setStatus(result.ok ? t(result.requestMade ? "vision.testOk" : "vision.configOk") : result.error);
    } catch { setStatus(t("vision.testFailed")); }
    finally { setBusy(false); }
  };
  return <SettingsGroup title={t("vision.settingsTitle")} description={t("vision.disclosure")}>
    <SettingsRow title={t("vision.enable")} description={t("vision.failurePolicy")}>
      <input aria-label={t("vision.enable")} type="checkbox" checked={settings?.enabled ?? false} disabled={!settings || busy} onChange={(event) => void save(event.target.checked)} />
    </SettingsRow>
    <SettingsRow title={t("vision.auxiliaryModel")} description={t("vision.sameAccount")}>
      <span className="settings-hint">deepseek-v4-flash-vision-exp</span>
    </SettingsRow>
    <SettingsRow title={t("vision.testTitle")} description={t("vision.testDescription")}>
      <div className="settings-pill-row">
        <select className="settings-select" aria-label={t("vision.testProvider")} disabled={busy || !candidates.length} value={selected ? `${selected.providerId}/${selected.modelId}` : ""} onChange={(event) => setSelection(event.target.value)}>
          {!candidates.length ? <option value="">{t("vision.chooseProvider")}</option> : candidates.map((model) => <option key={`${model.providerId}/${model.modelId}`} value={`${model.providerId}/${model.modelId}`}>{model.providerName} · {model.label}</option>)}
        </select>
        <button type="button" className="button button--secondary" disabled={busy || !selected} onClick={() => void test(false)}>{t("vision.validateConfig")}</button>
        <button type="button" className="button button--secondary" disabled={busy || !selected} onClick={() => void test(true)}>{t("vision.testSend")}</button>
        {status ? <span className="settings-hint" role="status">{status}</span> : null}
      </div>
    </SettingsRow>
  </SettingsGroup>;
}
