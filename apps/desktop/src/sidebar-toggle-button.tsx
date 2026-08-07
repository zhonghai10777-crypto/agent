import { SidebarToggleIcon } from "./icons";
import { useI18n } from "./i18n/I18nProvider";

interface SidebarToggleButtonProps {
  readonly collapsed: boolean;
  readonly shortcutLabel: string;
  readonly onToggle: () => void;
}

export function SidebarToggleButton({ collapsed, shortcutLabel, onToggle }: SidebarToggleButtonProps) {
  const { t } = useI18n();
  return (
    <div className="shortcut-tooltip-wrap sidebar-toggle">
      <button
        aria-label={t("sidebarToggle.toggle")}
        aria-pressed={!collapsed}
        className="icon-button sidebar-toggle__button"
        data-testid="sidebar-toggle"
        type="button"
        onClick={onToggle}
      >
        <SidebarToggleIcon />
      </button>
      <span className="shortcut-tooltip sidebar-toggle__tooltip" role="tooltip">
        <span>{t("sidebarToggle.toggle")}</span>
        <kbd>{shortcutLabel}</kbd>
      </span>
    </div>
  );
}
