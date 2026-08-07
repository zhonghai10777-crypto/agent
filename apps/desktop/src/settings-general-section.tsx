import { useEffect, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { Locale, ModelSettingsScopeMode } from "./desktop-state";
import { useI18n } from "./i18n/I18nProvider";
import { SettingsGroup, SettingsInfoRow, SettingsRow, settingsPill } from "./settings-utils";

interface SettingsGeneralSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly modelSettingsScopeMode: ModelSettingsScopeMode;
  readonly integratedTerminalShell: string;
  readonly locale: Locale;
  readonly onSetLocale: (locale: Locale) => void;
  readonly onSetModelSettingsScopeMode: (mode: ModelSettingsScopeMode) => void;
  readonly onSetIntegratedTerminalShell: (shellPath: string) => void;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
}

export function SettingsGeneralSection({
  runtime,
  modelSettingsScopeMode,
  integratedTerminalShell,
  locale,
  onSetLocale,
  onSetModelSettingsScopeMode,
  onSetIntegratedTerminalShell,
  onToggleSkillCommands,
}: SettingsGeneralSectionProps) {
  const { t } = useI18n();
  const connectedCount = runtime?.providers.filter((p) => p.hasAuth).length ?? 0;
  const [terminalShellDraft, setTerminalShellDraft] = useState(integratedTerminalShell);

  useEffect(() => {
    setTerminalShellDraft(integratedTerminalShell);
  }, [integratedTerminalShell]);

  const commitTerminalShellDraft = () => {
    if (terminalShellDraft !== integratedTerminalShell) {
      onSetIntegratedTerminalShell(terminalShellDraft);
    }
  };

  return (
    <>
      <SettingsGroup title={t("settings.section.general")}>
        <SettingsRow title={t("settings.general.language")} description={t("settings.general.languageDesc")}>
          <div className="settings-pill-row">
            <button
              className={settingsPill(locale === "zh-CN")}
              type="button"
              aria-pressed={locale === "zh-CN"}
              onClick={() => onSetLocale("zh-CN")}
            >
              简体中文
            </button>
            <button
              className={settingsPill(locale === "en")}
              type="button"
              aria-pressed={locale === "en"}
              onClick={() => onSetLocale("en")}
            >
              English
            </button>
          </div>
        </SettingsRow>
        <SettingsInfoRow
          label={t("settings.general.connectedProviders")}
          value={connectedCount > 0 ? String(connectedCount) : t("settings.general.none")}
        />
        <SettingsInfoRow label={t("settings.general.discoveredSkills")} value={String(runtime?.skills.length ?? 0)} />
        <SettingsRow
          title={t("settings.general.modelSettingsScope")}
          description={t("settings.general.modelSettingsScopeDesc")}
        >
          <div className="settings-pill-row">
            <button
              className={settingsPill(modelSettingsScopeMode === "app-global")}
              type="button"
              aria-pressed={modelSettingsScopeMode === "app-global"}
              onClick={() => onSetModelSettingsScopeMode("app-global")}
            >
              {t("settings.general.appGlobal")}
            </button>
            <button
              className={settingsPill(modelSettingsScopeMode === "per-repo")}
              type="button"
              aria-pressed={modelSettingsScopeMode === "per-repo"}
              onClick={() => onSetModelSettingsScopeMode("per-repo")}
            >
              {t("settings.general.perRepo")}
            </button>
          </div>
        </SettingsRow>
        <SettingsRow
          title={t("settings.general.enableSkillCommands")}
          description={t("settings.general.enableSkillCommandsDesc")}
        >
          <input
            aria-label={t("settings.general.enableSkillCommands")}
            checked={runtime?.settings.enableSkillCommands ?? true}
            type="checkbox"
            onChange={(event) => onToggleSkillCommands(event.target.checked)}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.general.integratedShell")}
          description={t("settings.general.integratedShellDesc")}
        >
          <input
            aria-label={t("settings.general.integratedShell")}
            className="settings-text-input"
            placeholder={t("settings.general.integratedShellPlaceholder")}
            spellCheck={false}
            type="text"
            value={terminalShellDraft}
            onBlur={commitTerminalShellDraft}
            onChange={(event) => setTerminalShellDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.shortcuts")}>
        <SettingsInfoRow label={t("settings.general.shortcutNewThread")} value="Cmd+Shift+O" />
        <SettingsInfoRow label={t("settings.general.shortcutOpenSettings")} value="Cmd+," />
        <SettingsInfoRow label={t("settings.general.shortcutToggleTerminal")} value="Cmd+J" />
        <SettingsInfoRow label={t("settings.general.shortcutNewTerminalTab")} value="Cmd+T" />
        <SettingsInfoRow label={t("settings.general.shortcutSendMessage")} value="Enter" />
        <SettingsInfoRow label={t("settings.general.shortcutNewLine")} value="Shift+Enter" />
      </SettingsGroup>
    </>
  );
}
