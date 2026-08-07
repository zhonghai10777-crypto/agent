import type { ReactNode } from "react";
import { useI18n } from "./i18n/I18nProvider";

export interface SecondarySurfaceNavItem {
  readonly id: string;
  readonly label: string;
}

interface SecondarySurfaceProps {
  readonly title: string;
  readonly onBack: () => void;
  readonly navItems?: readonly SecondarySurfaceNavItem[];
  readonly activeNavId?: string;
  readonly onSelectNav?: (id: string) => void;
  readonly testId?: string;
  readonly children: ReactNode;
}

export function SecondarySurface({
  title,
  onBack,
  navItems = [],
  activeNavId,
  onSelectNav,
  testId,
  children,
}: SecondarySurfaceProps) {
  const { t } = useI18n();
  return (
    <div className="secondary-surface" data-testid={testId}>
      <aside className="secondary-surface__sidebar">
        <button className="secondary-surface__back" type="button" onClick={onBack}>
          <span aria-hidden="true">←</span>
          <span>{t("secondarySurface.backToApp")}</span>
        </button>
        <div className="secondary-surface__title">{title}</div>
        {navItems.length > 0 ? (
          <nav className="secondary-surface__nav" aria-label={t("secondarySurface.sections", { title })}>
            {navItems.map((item) => (
              <button
                key={item.id}
                className={`secondary-surface__nav-item ${activeNavId === item.id ? "secondary-surface__nav-item--active" : ""}`}
                type="button"
                onClick={() => onSelectNav?.(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        ) : null}
      </aside>
      <main className="secondary-surface__content">{children}</main>
    </div>
  );
}
