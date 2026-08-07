import type { ThemeMode, ThemePresetId } from "./desktop-state";
import { SettingsGroup, SettingsRow } from "./settings-utils";
import { themePresets } from "./theme-presets";
import { useI18n } from "./i18n/I18nProvider";
import type { MessageKey } from "./i18n";

interface SettingsAppearanceSectionProps {
  readonly themeMode: ThemeMode;
  readonly themePresetId: ThemePresetId;
  readonly onSetThemeMode: (mode: ThemeMode) => void;
  readonly onSetThemePresetId: (presetId: ThemePresetId) => void;
  readonly enableTransparency: boolean;
  readonly onSetEnableTransparency: (enabled: boolean) => void;
}

const THEME_OPTION_MODES: readonly ThemeMode[] = ["system", "light", "dark"];

const THEME_PRESET_KEYS: Record<ThemePresetId, { nameKey: MessageKey; descKey: MessageKey }> = {
  default: { nameKey: "theme.defaultName", descKey: "theme.defaultDesc" },
  catppuccin: { nameKey: "theme.catppuccinName", descKey: "theme.catppuccinDesc" },
  "tokyo-night": { nameKey: "theme.tokyoNightName", descKey: "theme.tokyoNightDesc" },
  nord: { nameKey: "theme.nordName", descKey: "theme.nordDesc" },
  dracula: { nameKey: "theme.draculaName", descKey: "theme.draculaDesc" },
  gruvbox: { nameKey: "theme.gruvboxName", descKey: "theme.gruvboxDesc" },
  github: { nameKey: "theme.githubName", descKey: "theme.githubDesc" },
  vscode: { nameKey: "theme.vscodeName", descKey: "theme.vscodeDesc" },
};

const THEME_OPTION_TITLE_KEYS: Record<ThemeMode, MessageKey> = {
  system: "settings.appearance.system",
  light: "settings.appearance.light",
  dark: "settings.appearance.dark",
};

const THEME_OPTION_DESCRIPTION_KEYS: Record<ThemeMode, MessageKey> = {
  system: "settings.appearance.systemDesc",
  light: "settings.appearance.lightDesc",
  dark: "settings.appearance.darkDesc",
};

export function SettingsAppearanceSection({
  themeMode,
  themePresetId,
  onSetThemeMode,
  onSetThemePresetId,
  enableTransparency,
  onSetEnableTransparency,
}: SettingsAppearanceSectionProps) {
  const { t } = useI18n();
  return (
    <>
      <SettingsGroup title={t("settings.appearance.themePreset")}>
        <div className="theme-preset-grid">
          {themePresets.map((preset) => (
            <label
              className={`theme-preset-card${themePresetId === preset.id ? " theme-preset-card--active" : ""}`}
              key={preset.id}
            >
              <input
                checked={themePresetId === preset.id}
                name="theme-preset"
                type="radio"
                onChange={() => onSetThemePresetId(preset.id)}
              />
              <span className="theme-preset-card__preview" aria-hidden="true">
                {preset.swatches.map((swatch) => (
                  <span
                    className="theme-preset-card__swatch"
                    key={swatch}
                    style={{ background: swatch }}
                  />
                ))}
              </span>
              <span className="theme-preset-card__body">
                <span className="theme-preset-card__title">{t(THEME_PRESET_KEYS[preset.id].nameKey)}</span>
                <span className="theme-preset-card__description">{t(THEME_PRESET_KEYS[preset.id].descKey)}</span>
              </span>
            </label>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.appearance.theme")}>
        {THEME_OPTION_MODES.map((mode) => (
          <SettingsRow
            key={mode}
            title={t(THEME_OPTION_TITLE_KEYS[mode])}
            description={t(THEME_OPTION_DESCRIPTION_KEYS[mode])}
          >
            <input
              checked={themeMode === mode}
              name="theme"
              type="radio"
              onChange={() => onSetThemeMode(mode)}
            />
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title={t("settings.appearance.visuals")}>
        <SettingsRow
          title={t("settings.appearance.windowTransparency")}
          description={t("settings.appearance.windowTransparencyDesc")}
        >
          <input
            aria-label={t("settings.appearance.windowTransparency")}
            type="checkbox"
            checked={enableTransparency}
            onChange={(event) => onSetEnableTransparency(event.currentTarget.checked)}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
