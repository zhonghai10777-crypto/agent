import type { DesktopNotificationPermissionStatus } from "./ipc";
import type { NotificationPreferences } from "./desktop-state";
import { useI18n } from "./i18n/I18nProvider";
import type { Translator } from "./i18n";
import { PRODUCT } from "./product";
import { SettingsGroup, SettingsRow } from "./settings-utils";

interface SettingsNotificationsSectionProps {
  readonly notificationPreferences: NotificationPreferences;
  readonly notificationPermissionStatus: DesktopNotificationPermissionStatus;
  readonly notificationPermissionPending: boolean;
  readonly onSetNotificationPreferences: (preferences: Partial<NotificationPreferences>) => void;
  readonly onRequestNotificationPermission: () => void;
  readonly onOpenSystemNotificationSettings: () => void;
}

export function SettingsNotificationsSection({
  notificationPreferences,
  notificationPermissionStatus,
  notificationPermissionPending,
  onSetNotificationPreferences,
  onRequestNotificationPermission,
  onOpenSystemNotificationSettings,
}: SettingsNotificationsSectionProps) {
  const { t } = useI18n();
  const statusLabel = labelForPermissionStatus(notificationPermissionStatus, t);
  const statusDescription = descriptionForPermissionStatus(notificationPermissionStatus, t);
  const showAskMacOs = notificationPermissionStatus === "default";
  const showOpenSystemSettings = notificationPermissionStatus === "denied";
  const showRecoveryActions = showAskMacOs || showOpenSystemSettings;

  return (
    <>
      <SettingsGroup
        title={t("settings.notifications.system")}
        description={t("settings.notifications.systemDesc", { product: PRODUCT.name })}
      >
        <SettingsRow title={t("settings.notifications.macAccess")} description={statusDescription}>
          <span className="settings-row__value">{statusLabel}</span>
        </SettingsRow>
        {showRecoveryActions ? (
          <SettingsRow
            title={t("settings.notifications.turnOn")}
            description={
              showAskMacOs
                ? t("settings.notifications.turnOnAskDesc", { product: PRODUCT.name })
                : t("settings.notifications.turnOnDeniedDesc", { product: PRODUCT.name })
            }
          >
            <div className="settings-row__actions">
              {showAskMacOs ? (
                <button
                  className="button button--secondary"
                  disabled={notificationPermissionPending}
                  type="button"
                  onClick={onRequestNotificationPermission}
                >
                  {t("settings.notifications.askMacos")}
                </button>
              ) : null}
              {showOpenSystemSettings ? (
                <button
                  className="button button--secondary"
                  disabled={notificationPermissionPending}
                  type="button"
                  onClick={onOpenSystemNotificationSettings}
                >
                  {t("settings.notifications.openSystemSettings")}
                </button>
              ) : null}
            </div>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.notifications.inAppAlerts")}
        description={t("settings.notifications.inAppAlertsDesc")}
      >
        <SettingsRow
          title={t("settings.notifications.backgroundCompletion")}
          description={t("settings.notifications.backgroundCompletionDesc")}
        >
          <input
            aria-label={t("settings.notifications.backgroundCompletion")}
            checked={notificationPreferences.backgroundCompletion}
            type="checkbox"
            onChange={(event) => onSetNotificationPreferences({ backgroundCompletion: event.target.checked })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.notifications.backgroundFailures")}
          description={t("settings.notifications.backgroundFailuresDesc")}
        >
          <input
            aria-label={t("settings.notifications.backgroundFailures")}
            checked={notificationPreferences.backgroundFailure}
            type="checkbox"
            onChange={(event) => onSetNotificationPreferences({ backgroundFailure: event.target.checked })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.notifications.needsInput")}
          description={t("settings.notifications.needsInputDesc")}
        >
          <input
            aria-label={t("settings.notifications.needsInput")}
            checked={notificationPreferences.attentionNeeded}
            type="checkbox"
            onChange={(event) => onSetNotificationPreferences({ attentionNeeded: event.target.checked })}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function labelForPermissionStatus(status: DesktopNotificationPermissionStatus, t: Translator): string {
  switch (status) {
    case "granted":
      return t("settings.notifications.enabled");
    case "denied":
      return t("settings.notifications.turnedOff");
    case "default":
      return t("settings.notifications.notEnabledYet");
    case "unsupported":
      return t("settings.notifications.unavailable");
    default:
      return t("settings.notifications.checking");
  }
}

function descriptionForPermissionStatus(status: DesktopNotificationPermissionStatus, t: Translator): string {
  switch (status) {
    case "granted":
      return t("settings.notifications.grantedDesc", { product: PRODUCT.name });
    case "denied":
      return t("settings.notifications.deniedDesc", { product: PRODUCT.name });
    case "default":
      return t("settings.notifications.defaultDesc", { product: PRODUCT.name });
    case "unsupported":
      return t("settings.notifications.unsupportedDesc");
    default:
      return t("settings.notifications.checkingDesc", { product: PRODUCT.name });
  }
}
