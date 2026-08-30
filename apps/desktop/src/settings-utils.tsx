import type { ReactNode } from "react";
import type { RuntimeSettingsSnapshot, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { Translator } from "./i18n";

export type SettingsSection = "appearance" | "general" | "providers" | "models" | "library" | "web" | "notifications";

export const THINKING_LEVELS: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function settingsPill(active: boolean): string {
  return `settings-pill${active ? " settings-pill--active" : ""}`;
}

export function labelForThinking(
  level: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>,
  t: Translator,
): string {
  switch (level) {
    case "low":
      return t("thinking.low");
    case "medium":
      return t("thinking.medium");
    case "high":
      return t("thinking.high");
    case "xhigh":
      return t("thinking.xhigh");
    default:
      return t("thinking.max");
  }
}

export function sectionTitle(section: SettingsSection, t: Translator): string {
  switch (section) {
    case "appearance":
      return t("settings.section.appearance");
    case "providers":
      return t("settings.section.providers");
    case "models":
      return t("settings.section.models");
    case "notifications":
      return t("settings.section.notifications");
    case "web":
      return t("settings.section.web");
    case "library":
      return t("settings.section.library");
    default:
      return t("settings.section.general");
  }
}

export function sectionDescription(section: SettingsSection, workspaceName: string, t: Translator): string {
  switch (section) {
    case "appearance":
      return t("settings.section.appearanceDesc");
    case "providers":
      return t("settings.section.providersDesc", { workspaceName });
    case "models":
      return t("settings.section.modelsDesc");
    case "notifications":
      return t("settings.section.notificationsDesc");
    case "web":
      return t("settings.section.webDesc");
    case "library":
      return t("settings.section.libraryDesc");
    default:
      return t("settings.section.generalDesc");
  }
}

export function filterModels(
  models: readonly RuntimeSnapshot["models"][number][],
  query: string,
): readonly RuntimeSnapshot["models"][number][] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return models;
  }
  return models.filter((model) =>
    [model.providerId, model.providerName, model.modelId, model.label].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}

/* ── Layout components ────────────────────────────────── */

export function SettingsGroup({
  title,
  description,
  children,
}: {
  readonly title?: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="settings-section">
      {title ? <h3 className="settings-section__title">{title}</h3> : null}
      {description ? <p className="settings-section__description">{description}</p> : null}
      <div className="settings-group">{children}</div>
    </div>
  );
}

export function SettingsRow({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row__label">
        <div className="settings-row__title">{title}</div>
        {description ? <div className="settings-row__description">{description}</div> : null}
      </div>
      {children ? <div className="settings-row__control">{children}</div> : null}
    </div>
  );
}

export function SettingsInfoRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="settings-row">
      <div className="settings-row__label">
        <div className="settings-row__title">{label}</div>
      </div>
      <div className="settings-row__control">
        <span className="settings-row__value">{value}</span>
      </div>
    </div>
  );
}

export function ProviderRow({
  provider,
  onLoginProvider,
  onLogoutProvider,
  onConfigureApiKey,
  t,
}: {
  readonly provider: RuntimeSnapshot["providers"][number];
  readonly onLoginProvider: (providerId: string) => void;
  readonly onLogoutProvider: (providerId: string) => void;
  readonly onConfigureApiKey: (provider: RuntimeSnapshot["providers"][number]) => void;
  readonly t: Translator;
}) {
  const action = resolveProviderAction(provider, t, onLoginProvider, onLogoutProvider, onConfigureApiKey);
  return (
    <div className="settings-row">
      <div className="settings-row__label">
        <div className="settings-row__title">{provider.name}</div>
        <div className="settings-row__description">{describeProviderStatus(provider, t)}</div>
      </div>
      {action ? (
        <div className="settings-row__control">
          <button
            className="button button--secondary"
            disabled={action.disabled}
            type="button"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function describeProviderStatus(provider: RuntimeSnapshot["providers"][number], t: Translator): string {
  switch (provider.authSource) {
    case "oauth":
      return t("provider.oauthConnected");
    case "auth_file":
      return t("provider.apiKeyConnected");
    case "env":
      return t("provider.envConnected");
    case "external":
      return provider.hasAuth ? t("provider.externalConnected") : t("provider.configureExternally");
    default:
      if (provider.oauthSupported) {
        return t("provider.oauth");
      }
      if (provider.apiKeySetupSupported) {
        return t("provider.apiKey");
      }
      return provider.authType === "api_key" ? t("provider.apiKey") : t("provider.builtIn");
  }
}

function resolveProviderAction(
  provider: RuntimeSnapshot["providers"][number],
  t: Translator,
  onLoginProvider: (providerId: string) => void,
  onLogoutProvider: (providerId: string) => void,
  onConfigureApiKey: (provider: RuntimeSnapshot["providers"][number]) => void,
):
  | {
      readonly disabled: boolean;
      readonly label: string;
      readonly onClick?: () => void;
    }
  | undefined {
  if (provider.authSource === "oauth") {
    return {
      disabled: false,
      label: t("provider.logout"),
      onClick: () => onLogoutProvider(provider.id),
    };
  }

  if (provider.oauthSupported && provider.authSource === "none") {
    return {
      disabled: false,
      label: t("provider.login"),
      onClick: () => onLoginProvider(provider.id),
    };
  }

  if (provider.apiKeySetupSupported && (provider.authSource === "none" || provider.authSource === "auth_file")) {
    return {
      disabled: false,
      label: provider.authSource === "auth_file" ? t("provider.manage") : t("settings.providers.setApiKey"),
      onClick: () => onConfigureApiKey(provider),
    };
  }

  if (provider.authSource === "env" || provider.authSource === "external") {
    return undefined;
  }

  return {
    disabled: true,
    label: t("provider.configureExternally"),
  };
}
