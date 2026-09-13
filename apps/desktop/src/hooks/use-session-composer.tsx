import {
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type SetStateAction,
  useState,
  useRef,
} from "react";
import {
  type DesktopAppState,
  type SessionRecord,
} from "../desktop-state";
import { updateSnapshot } from "../app/desktop-app-state";
import {
  extractFilesFromDataTransfer,
  extractImageFilesFromClipboardData,
  readComposerAttachmentsFromFiles,
} from "../composer-attachments";
import { parseTreeComposerCommand } from "../composer-commands";
import type { PiDesktopApi } from "../ipc";

interface UseSessionComposerParams {
  readonly api: PiDesktopApi | undefined;
  readonly snapshot: DesktopAppState | null;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly selectedSession: SessionRecord | undefined;
  readonly composerDraft: string;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
  readonly composerDraftRef: MutableRefObject<string>;
  readonly composerRef: MutableRefObject<HTMLTextAreaElement | null>;
  readonly requiresModelSelection: boolean;
  readonly openTreeModal: () => void;
  readonly handleMentionKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly handleSlashKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export function useSessionComposer(params: UseSessionComposerParams) {
  const {
    api,
    snapshot,
    setSnapshot,
    selectedSession,
    composerDraft,
    setComposerDraft,
    composerDraftRef,
    composerRef,
    requiresModelSelection,
    openTreeModal,
    handleMentionKeyDown,
    handleSlashKeyDown,
  } = params;

  const [attachmentsClearedOnSubmit, setAttachmentsClearedOnSubmit] = useState(false);
  const submitting = useRef(new Set<string>());
  const composerAttachments = attachmentsClearedOnSubmit ? [] : (snapshot?.composerAttachments ?? []);
  const attachmentError = (error: unknown) => setSnapshot((current) => current ? { ...current, lastError: error instanceof Error ? error.message : String(error) } : current);

  const submitComposerDraft = (options: { readonly deliverAs?: "steer" | "followUp" } = {}) => {
    if (!api || !selectedSession) {
      return;
    }

    const hasComposerInput = composerDraft.trim().length > 0 || composerAttachments.length > 0;
    if (selectedSession.status === "running" && !hasComposerInput) {
      void updateSnapshot(api, setSnapshot, () => api.cancelCurrentRun());
      return;
    }

    const submissionKey = JSON.stringify([selectedSession.id, composerDraft, composerAttachments.map((attachment) => attachment.id)]);
    if (!hasComposerInput || submitting.current.has(submissionKey)) {
      return;
    }
    if (requiresModelSelection) {
      return;
    }

    const treeCommand = parseTreeComposerCommand(composerDraft);
    if (treeCommand?.type === "error") {
      setSnapshot((current) =>
        current
          ? {
              ...current,
              lastError: treeCommand.message,
            }
          : current,
      );
      return;
    }
    if (treeCommand?.type === "tree") {
      openTreeModal();
      return;
    }

    const previousDraft = composerDraft;
    submitting.current.add(submissionKey);
    setComposerDraft("");
    setAttachmentsClearedOnSubmit(true);
    void (async () => {
      const nextState = await updateSnapshot(api, setSnapshot, () =>
        api.submitComposer(previousDraft, { clientMessageId: crypto.randomUUID(), ...(selectedSession.status === "running" ? { deliverAs: options.deliverAs ?? "followUp" } : {}) }),
      );
      // Only apply the resolved draft if the user hasn't typed into the composer during the
      // in-flight submit; otherwise their new input would be clobbered.
      if (composerDraftRef.current === "") {
        setComposerDraft(nextState.composerDraft);
      }
    })().catch(() => {
      if (composerDraftRef.current === "") {
        setComposerDraft(previousDraft);
      }
    }).finally(() => {
      submitting.current.delete(submissionKey);
      if (submitting.current.size === 0) setAttachmentsClearedOnSubmit(false);
    });
  };

  const handlePickAttachments = () => {
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.pickComposerAttachments());
  };

  const handleRemoveAttachment = (attachmentId: string) => {
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.removeComposerAttachment(attachmentId));
  };

  const handleEditQueuedMessage = (messageId: string) => {
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.editQueuedComposerMessage(messageId, composerDraft)).then(() => {
      composerRef.current?.focus();
    });
  };

  const handleCancelQueuedEdit = () => {
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.cancelQueuedComposerEdit()).then(() => {
      composerRef.current?.focus();
    });
  };

  const handleRemoveQueuedMessage = (messageId: string) => {
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.removeQueuedComposerMessage(messageId));
  };

  const handleSteerQueuedMessage = (messageId: string) => {
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.steerQueuedComposerMessage(messageId));
  };

  const handleImagePaste = (event: ClipboardEvent<HTMLDivElement>, onFiles: (files: File[]) => void) => {
    const files = extractImageFilesFromClipboardData(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    onFiles(files);
  };

  const handleAttachmentDrop = (event: DragEvent<HTMLDivElement>, onFiles: (files: File[]) => void) => {
    event.preventDefault();
    const files = extractFilesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) {
      return;
    }
    onFiles(files);
  };

  async function addAttachmentsToSessionComposer(files: File[]) {
    if (!api) {
      return;
    }
    try {
      const valid = await readComposerAttachmentsFromFiles(files, composerAttachments);
      if (valid.length) await updateSnapshot(api, setSnapshot, () => api.addComposerAttachments(valid));
    } catch (error) {
      attachmentError(error);
    }
  }

  const handleComposerPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    handleImagePaste(event, (files) => {
      void addAttachmentsToSessionComposer(files);
    });
  };

  const handleComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    handleAttachmentDrop(event, (files) => {
      void addAttachmentsToSessionComposer(files);
    });
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleMentionKeyDown(event)) {
      return;
    }

    if (handleSlashKeyDown(event)) {
      return;
    }

    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && selectedSession?.status === "running") {
      event.preventDefault();
      submitComposerDraft({ deliverAs: (event.metaKey || event.ctrlKey) ? "steer" : "followUp" });
      return;
    }

    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    if (!composerDraft.trim() && composerAttachments.length === 0) {
      return;
    }
    if (requiresModelSelection) {
      return;
    }

    submitComposerDraft();
  };

  return {
    composerAttachments,
    submitComposerDraft,
    handlePickAttachments,
    handleRemoveAttachment,
    handleEditQueuedMessage,
    handleCancelQueuedEdit,
    handleRemoveQueuedMessage,
    handleSteerQueuedMessage,
    handleComposerPaste,
    handleComposerDrop,
    handleComposerKeyDown,
  };
}
