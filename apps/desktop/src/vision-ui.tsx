import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionRef } from "@pi-gui/session-driver";
import type { SessionTranscriptMessage } from "@pi-gui/pi-sdk-driver";
import type { StoredVisionEvidence, VisionProgress, VisionSessionView } from "@pi-gui/session-driver/vision-types";
import type { ComposerAttachment } from "./desktop-state";
import { useI18n } from "./i18n/I18nProvider";

const VisionContext = createContext<{ ref: SessionRef; running: boolean; view?: VisionSessionView } | undefined>(undefined);

/** Only lightweight metadata is refreshed at stage boundaries, never on token deltas. */
export function VisionSessionProvider({ sessionRef, running, progress, children }: {
  readonly sessionRef: SessionRef;
  readonly running: boolean;
  readonly progress?: VisionProgress;
  readonly children: ReactNode;
}) {
  const [view, setView] = useState<VisionSessionView>();
  const [error, setError] = useState<string>();
  const { t } = useI18n();
  const revision = JSON.stringify(progress);
  const { workspaceId, sessionId } = sessionRef;
  useEffect(() => {
    let active = true;
    void window.piApp?.getVisionSession({ workspaceId, sessionId }).then((value) => {
      if (active) { setView(value); setError(undefined); }
    }).catch(() => { if (active) setError(t("vision.storageError")); });
    return () => { active = false; };
  }, [workspaceId, sessionId, revision, running, t]);
  const value = useMemo(() => {
    const saved = view?.progress.find((entry) => entry.operationId === progress?.operationId);
    const latest = saved && (saved.revision ?? 0) > (progress?.revision ?? 0) ? saved : progress;
    return { ref: { workspaceId, sessionId }, running, view: latest ? {
      images: view?.images ?? [], requests: view?.requests ?? 0, usage: view?.usage, usageUnknown: view?.usageUnknown ?? false,
      progress: [...(view?.progress ?? []).filter((entry) => entry.operationId !== latest.operationId), latest],
    } : view };
  }, [workspaceId, sessionId, running, view, revision]);
  return <VisionContext.Provider value={value}>
    {children}
    {error ? <p className="vision-status vision-status--error" role="status">{error}</p> : null}
    {view && view.requests > 0 ? <p className="vision-usage" data-testid="vision-usage">
      {t("vision.usage", { requests: view.requests, input: view.usage?.inputTokens ?? "?", output: view.usage?.outputTokens ?? "?" })}
      {view.usageUnknown ? ` · ${t("vision.usageUnknown")}` : ""}
    </p> : null}
  </VisionContext.Provider>;
}

export function VisionUploadNotice({ modelId, supportsImages, attachments, queued = false }: {
  readonly modelId?: string;
  readonly supportsImages?: boolean;
  readonly attachments: readonly ComposerAttachment[];
  readonly queued?: boolean;
}) {
  const { t } = useI18n();
  if (supportsImages || !["deepseek-v4-pro", "deepseek-v4-flash"].includes(modelId ?? "") || !attachments.some((item) => item.kind === "image")) return null;
  return <p className="vision-upload-notice" data-testid="vision-disclosure">
    {t("vision.disclosure")}{queued ? ` ${t("vision.queueModel")}` : ""}
  </p>;
}

export function VisionMessageStatus({ item }: { readonly item: SessionTranscriptMessage }) {
  const context = useContext(VisionContext);
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [evidence, setEvidence] = useState<readonly StoredVisionEvidence[]>([]);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string>();
  const bindings = context?.view?.images.filter((image) => image.clientMessageId === item.id || image.sourceMessageEntryId === item.sourceMessageEntryId) ?? [];
  const sourceIds = new Set([item.id, item.sourceMessageEntryId, ...bindings.flatMap((image) => [image.clientMessageId, image.sourceMessageEntryId])]);
  const operations = context?.view?.progress.filter((operation) => sourceIds.has(operation.sourceMessageId)) ?? [];
  const progress = operations.at(-1);
  const evidenceIds = [...new Set([...bindings.flatMap((image) => image.evidenceId ? [image.evidenceId] : []), ...operations.flatMap((operation) => operation.evidenceIds ?? [])])];
  const evidenceKey = evidenceIds.join(",");
  const workspaceId = context?.ref.workspaceId;
  const sessionId = context?.ref.sessionId;
  useEffect(() => {
    if (!expanded || !workspaceId || !sessionId || !evidenceKey) return;
    let active = true;
    setLoading(true);
    void Promise.all(evidenceKey.split(",").map((id) => window.piApp!.getVisionEvidence({ workspaceId, sessionId }, id)))
      .then((values) => { if (active) { setEvidence(values); setError(undefined); } })
      .catch(() => { if (active) setError(t("vision.storageError")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [expanded, workspaceId, sessionId, evidenceKey, t]);
  if (!context || !progress && !evidenceIds.length) return null;
  const retry = async () => {
    if (!progress || retrying || context.running) return;
    setRetrying(true);
    setError(undefined);
    try { await window.piApp!.retryVision(context.ref, progress.sourceMessageId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("vision.storageError")); }
    finally { setRetrying(false); }
  };
  return <div className="vision-status" data-testid="vision-status" data-stage={progress?.stage ?? "completed"}>
    <div className="vision-status__line" role="status">
      <span>{progress ? t(`vision.stage.${progress.stage}`, { count: progress.imageCount, model: progress.primaryModelId }) : t("vision.stage.completed")}</span>
      {progress && ["failed", "interrupted", "cancelled"].includes(progress.stage) ? <button type="button" className="timeline-item__action" disabled={context.running || retrying} onClick={() => void retry()}>{t("vision.retry")}</button> : null}
      {evidenceIds.length ? <button type="button" className="timeline-item__action" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t("vision.viewEvidence")}</button> : null}
    </div>
    {progress ? <div className="vision-status__models">{progress.visionModelId} → {progress.primaryModelId}</div> : null}
    {progress?.errorCode ? <p className="vision-status__error">{t(`vision.error.${progress.errorCode}`)}</p> : null}
    {error ? <p className="vision-status__error" role="alert">{error}</p> : null}
    {expanded ? <div className="vision-evidence" data-testid="vision-evidence">
      {loading ? <p>{t("vision.loading")}</p> : evidence.map((entry) => <EvidenceBody key={entry.evidenceId} evidence={entry} />)}
    </div> : null}
  </div>;
}

function EvidenceBody({ evidence }: { readonly evidence: StoredVisionEvidence }) {
  const { t } = useI18n();
  return <div>
    <div className="vision-status__models">{evidence.modelId} · {new Date(evidence.createdAt).toLocaleString()}</div>
    {evidence.body.images.map((image) => <section key={image.imageId}>
      <p><code>{image.imageId}</code> · {t(`vision.quality.${image.quality}`)}</p>
      <p>{image.summary}</p>
      {image.extractedText ? <pre>{image.extractedText}</pre> : null}
      {image.observations.map((text, index) => <p key={index}>{text}</p>)}
      {image.tables.map((table, index) => <div className="vision-evidence__table" key={index}><table>
        <caption>{table.title}</caption>
        <thead><tr>{table.headers.map((cell, i) => <th key={i}>{cell}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell ?? t("vision.quality.unreadable")}</td>)}</tr>)}</tbody>
      </table></div>)}
      {image.uncertainties.length ? <div className="vision-evidence__uncertainties"><strong>{t("vision.uncertainties")}</strong>{image.uncertainties.map((text, i) => <p key={i}>{text}</p>)}</div> : null}
    </section>)}
    {evidence.body.crossImageObservations.map((text, index) => <p key={index}>{text}</p>)}
  </div>;
}
