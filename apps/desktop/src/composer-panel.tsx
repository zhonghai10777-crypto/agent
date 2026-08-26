import { type ClipboardEvent, type Dispatch, type DragEvent, type KeyboardEvent, type RefObject, type SetStateAction } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { PermissionMode } from "@pi-gui/session-driver";
import type { ComposerAttachment, QueuedComposerMessage, SessionRecord } from "./desktop-state";
import type { MentionOption } from "./hooks/use-mention-menu";
import { ArrowUpIcon, PlusIcon, StopSquareIcon } from "./icons";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandSection,
  ComposerSlashOption,
  ComposerSlashOptionEmptyState,
} from "./composer-commands";
import { ComposerSurface } from "./composer-surface";
import { ModelOnboardingNoticeBanner } from "./model-onboarding-notice";
import type { ModelOnboardingState, ModelOnboardingSettingsSection } from "./model-onboarding";
import { ModelSelector } from "./model-selector";
import type { ExtensionDockModel } from "./extension-session-ui";
import { useI18n } from "./i18n/I18nProvider";

interface ComposerPanelProps {
  readonly selectedSession: SessionRecord;
  readonly lastError?: string;
  readonly runtime?: RuntimeSnapshot;
  readonly activeSlashCommand?: ComposerSlashCommand;
  readonly activeSlashCommandMeta?: string;
  readonly composerDraft: string;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly runningLabel: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly queuedMessages: readonly QueuedComposerMessage[];
  readonly editingQueuedMessageId?: string;
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly slashSections: readonly ComposerSlashCommandSection[];
  readonly slashOptions: readonly ComposerSlashOption[];
  readonly selectedSlashCommand?: ComposerSlashCommand;
  readonly selectedSlashOption?: ComposerSlashOption;
  readonly showSlashMenu: boolean;
  readonly showSlashOptionMenu: boolean;
  readonly slashOptionEmptyState?: ComposerSlashOptionEmptyState;
  readonly onClearSlashCommand: () => void;
  readonly onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onComposerPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onComposerDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly onPickAttachments: () => void;
  readonly onRemoveAttachment: (attachmentId: string) => void;
  readonly onEditQueuedMessage: (messageId: string) => void;
  readonly onCancelQueuedEdit: () => void;
  readonly onRemoveQueuedMessage: (messageId: string) => void;
  readonly onSteerQueuedMessage: (messageId: string) => void;
  readonly onSelectSlashCommand: (command: ComposerSlashCommand) => void;
  readonly onSelectSlashOption: (option: ComposerSlashOption) => void;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
  readonly permissionMode: PermissionMode;
  readonly onSetPermissionMode: (mode: PermissionMode) => void;
  readonly modelOnboarding: ModelOnboardingState;
  readonly onOpenModelSettings: (section: ModelOnboardingSettingsSection) => void;
  readonly onSubmit: () => void;
  readonly showMentionMenu: boolean;
  readonly mentionOptions: readonly MentionOption[];
  readonly selectedMentionIndex: number;
  readonly onSelectMention: (option: MentionOption) => void;
  readonly onEnableMentionExtension: (option: Extract<MentionOption, { kind: "extension" }>) => void;
  readonly extensionDock?: ExtensionDockModel;
  readonly extensionDockExpanded: boolean;
  readonly onToggleExtensionDock: () => void;
  readonly onCompact?: () => void;
}

export function ComposerPanel({
  selectedSession,
  lastError,
  runtime,
  activeSlashCommand,
  activeSlashCommandMeta,
  composerDraft,
  setComposerDraft,
  composerRef,
  runningLabel,
  attachments,
  queuedMessages,
  editingQueuedMessageId,
  provider,
  modelId,
  thinkingLevel,
  slashSections,
  slashOptions,
  selectedSlashCommand,
  selectedSlashOption,
  showSlashMenu,
  showSlashOptionMenu,
  slashOptionEmptyState,
  onClearSlashCommand,
  onComposerKeyDown,
  onComposerPaste,
  onComposerDrop,
  onPickAttachments,
  onRemoveAttachment,
  onEditQueuedMessage,
  onCancelQueuedEdit,
  onRemoveQueuedMessage,
  onSteerQueuedMessage,
  onSelectSlashCommand,
  onSelectSlashOption,
  onSetModel,
  onSetThinking,
  permissionMode,
  onSetPermissionMode,
  modelOnboarding,
  onOpenModelSettings,
  onSubmit,
  showMentionMenu,
  mentionOptions,
  selectedMentionIndex,
  onSelectMention,
  onEnableMentionExtension,
  extensionDock,
  extensionDockExpanded,
  onToggleExtensionDock,
  onCompact,
}: ComposerPanelProps) {
  const { t } = useI18n();
  const hasComposerInput = composerDraft.trim().length > 0 || attachments.length > 0;
  const primaryActionIsStop = selectedSession.status === "running" && !hasComposerInput;
  const contextUsage = selectedSession.contextUsage;
  const contextPercent = contextUsage?.percent;
  const contextUsageSeverity = contextPercent == null ? "none" : contextPercent >= 75 ? "critical" : contextPercent >= 55 ? "warn" : "ok";

  return (
    <footer className="composer">
      <div className="conversation conversation--composer">
        <ComposerSurface
          lastError={lastError}
          activeSlashCommand={activeSlashCommand}
          activeSlashCommandMeta={activeSlashCommandMeta}
          topNotice={(
            <ModelOnboardingNoticeBanner notice={modelOnboarding.notice} onOpenSettings={onOpenModelSettings} />
          )}
          composerDraft={composerDraft}
          setComposerDraft={setComposerDraft}
          composerRef={composerRef}
          attachments={attachments}
          queuedMessages={queuedMessages}
          editingQueuedMessageId={editingQueuedMessageId}
          slashSections={slashSections}
          slashOptions={slashOptions}
          selectedSlashCommand={selectedSlashCommand}
          selectedSlashOption={selectedSlashOption}
          showSlashMenu={showSlashMenu}
          showSlashOptionMenu={showSlashOptionMenu}
          slashOptionEmptyState={slashOptionEmptyState}
          onClearSlashCommand={onClearSlashCommand}
          onComposerKeyDown={onComposerKeyDown}
          onComposerPaste={onComposerPaste}
          onComposerDrop={onComposerDrop}
          onRemoveAttachment={onRemoveAttachment}
          onEditQueuedMessage={onEditQueuedMessage}
          onCancelQueuedEdit={onCancelQueuedEdit}
          onRemoveQueuedMessage={onRemoveQueuedMessage}
          onSteerQueuedMessage={onSteerQueuedMessage}
          onSelectSlashCommand={onSelectSlashCommand}
          onSelectSlashOption={onSelectSlashOption}
          showMentionMenu={showMentionMenu}
          mentionOptions={mentionOptions}
          selectedMentionIndex={selectedMentionIndex}
          onSelectMention={onSelectMention}
          onEnableMentionExtension={onEnableMentionExtension}
          textareaLabel={t("composer.label")}
          textareaTestId="composer"
          textareaPlaceholder={t("composer.placeholder")}
          extensionDock={extensionDock}
          extensionDockExpanded={extensionDockExpanded}
          onToggleExtensionDock={onToggleExtensionDock}
          footer={(
            <div className="composer__footer">
              <div className="composer__footer-row">
                <div className="composer__hint">
                  {selectedSession.status === "running"
                    ? t("composer.enterToQueue", { runningLabel })
                    : t("composer.enterToSend")}
                  {" · "}
                  <ModelSelector
                    runtime={runtime}
                    provider={provider}
                    modelId={modelId}
                    thinkingLevel={thinkingLevel}
                    disabled={selectedSession.status === "running"}
                    unselectedModelLabel={modelOnboarding.unselectedModelLabel}
                    emptyModelTitle={modelOnboarding.emptyModelTitle}
                    onSetModel={onSetModel}
                    onSetThinking={onSetThinking}
                  />
                  {contextUsageSeverity !== "none" ? (
                    <ContextUsageIndicator
                      percent={contextPercent ?? 0}
                      severity={contextUsageSeverity}
                      onCompact={onCompact}
                      compactDisabled={selectedSession.status === "running"}
                    />
                  ) : null}
                  <button
                    type="button"
                    className={
                      "composer__permission-toggle" +
                      (permissionMode === "plan" ? " composer__permission-toggle--plan" : "")
                    }
                    aria-label={permissionMode === "plan" ? t("composer.permission.planHint") : t("composer.permission.autoHint")}
                    aria-pressed={permissionMode === "plan"}
                    onClick={() => onSetPermissionMode(permissionMode === "plan" ? "auto" : "plan")}
                  >
                    {permissionMode === "plan" ? t("composer.permission.plan") : t("composer.permission.auto")}
                  </button>
                </div>
                <div className="composer__actions">
                  <button
                    aria-label={t("composer.attachFiles")}
                    className="icon-button composer__attach"
                    type="button"
                    onClick={onPickAttachments}
                  >
                    <PlusIcon />
                  </button>
                  <button
                    aria-label={primaryActionIsStop ? t("composer.stopRun") : t("composer.sendMessage")}
                    className="button button--primary button--cta-icon"
                    data-testid="send"
                    type="button"
                    disabled={
                      !primaryActionIsStop &&
                      ((!composerDraft.trim() && attachments.length === 0) || modelOnboarding.requiresModelSelection)
                    }
                    onClick={onSubmit}
                  >
                    {primaryActionIsStop ? <StopSquareIcon /> : <ArrowUpIcon />}
                  </button>
                </div>
              </div>
            </div>
          )}
        />
      </div>
    </footer>
  );
}

function ContextUsageIndicator({
  percent,
  severity,
  onCompact,
  compactDisabled,
}: {
  readonly percent: number;
  readonly severity: "ok" | "warn" | "critical";
  readonly onCompact?: () => void;
  readonly compactDisabled: boolean;
}) {
  const { t } = useI18n();
  const rounded = Math.round(percent);
  const label = t(
    severity === "warn" || severity === "critical" ? "contextUsage.warn" : "contextUsage.used",
    { percent: rounded },
  );
  return (
    <span className={`context-usage context-usage--${severity}`} data-testid="context-usage">
      <span className="context-usage__text">{label}</span>
      {onCompact ? (
        <button
          className="context-usage__compact"
          type="button"
          disabled={compactDisabled}
          title={compactDisabled ? t("contextUsage.compressBusy") : t("contextUsage.compressHint")}
          onClick={onCompact}
        >
          {t("contextUsage.compress")}
        </button>
      ) : null}
    </span>
  );
}
