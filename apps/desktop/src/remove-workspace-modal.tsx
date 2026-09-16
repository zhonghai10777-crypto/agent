import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { WorkspaceRecord } from "./desktop-state";
import { trapDialogFocus } from "./dialog-focus";
import { useI18n } from "./i18n/I18nProvider";
import { PRODUCT } from "./product";
import { workspaceDisplayName } from "./workspace-context";

interface RemoveWorkspaceModalProps {
  readonly workspace: WorkspaceRecord;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/** Self-drawn confirm dialog for removing a workspace, replacing a blocking
 * `window.confirm()` (which ignores the app theme and pauses the renderer
 * process). Structured like fork-modal.tsx: aria-modal dialog, Tab focus trap,
 * Escape to cancel, initial focus on the primary action. */
export function RemoveWorkspaceModal({ workspace, onCancel, onConfirm }: RemoveWorkspaceModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("[data-remove-workspace-confirm='true']")?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapDialogFocus(event, dialogRef.current);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      className="tree-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        onCancel();
      }}
    >
      <div
        aria-modal="true"
        className="tree-modal tree-modal--compact"
        data-testid="remove-workspace-modal"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="tree-modal__header">
          <div>
            <h2 className="tree-modal__title">{t("sidebar.removeWorkspaceConfirmTitle")}</h2>
          </div>
          <button aria-label={t("common.cancel")} className="tree-modal__close" type="button" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="tree-modal__summary-step">
          <div className="tree-modal__summary-copy">
            {t("sidebar.removeWorkspaceConfirm", { name: workspaceDisplayName(workspace, t), product: PRODUCT.name })}
          </div>

          <div className="tree-modal__footer">
            <div className="tree-modal__actions">
              <button className="button button--secondary" type="button" onClick={onCancel}>
                {t("common.cancel")}
              </button>
              <button
                className="button button--primary"
                data-remove-workspace-confirm="true"
                data-testid="remove-workspace-modal-confirm"
                type="button"
                onClick={onConfirm}
              >
                {t("sidebar.removeWorkspaceConfirmAction")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
