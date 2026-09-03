import { useCallback, useEffect, useMemo, useState } from "react";
import { CUSTOM_PROVIDER_ID_PATTERN, isValidHttpBaseUrl } from "@pi-gui/pi-sdk-driver/custom-provider-types";
import type { CustomProviderConfig, CustomProviderModelConfig } from "./ipc";
import { useI18n } from "./i18n/I18nProvider";
import type { Translator } from "./i18n";
import { SettingsGroup } from "./settings-utils";

interface SettingsCustomEndpointsSectionProps {
  readonly existingProviderIds: readonly string[];
  readonly onSaveCustomProvider: (config: CustomProviderConfig) => Promise<string | undefined>;
  readonly onDeleteCustomProvider: (providerId: string) => Promise<string | undefined>;
}

type DialogMode = { kind: "closed" } | { kind: "create" } | { kind: "edit"; original: CustomProviderConfig };

export function SettingsCustomEndpointsSection({
  existingProviderIds,
  onSaveCustomProvider,
  onDeleteCustomProvider,
}: SettingsCustomEndpointsSectionProps) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<readonly CustomProviderConfig[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [dialog, setDialog] = useState<DialogMode>({ kind: "closed" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const api = window.piApp;
    if (!api) {
      return;
    }
    let cancelled = false;
    void api
      .listCustomProviders()
      .then((list) => {
        if (!cancelled) {
          setEntries(list);
          setLoadError(undefined);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const handleSave = useCallback(
    async (config: CustomProviderConfig): Promise<string | undefined> => {
      const error = await onSaveCustomProvider(config);
      if (!error) {
        reload();
      }
      return error;
    },
    [onSaveCustomProvider, reload],
  );

  const handleDelete = useCallback(
    async (providerId: string) => {
      const error = await onDeleteCustomProvider(providerId);
      if (error) {
        setLoadError(error);
        return;
      }
      reload();
    },
    [onDeleteCustomProvider, reload],
  );

  return (
    <>
      <SettingsGroup title={t("settings.endpoints.customEndpoints")} description={t("settings.endpoints.description")}>
        {loadError ? (
          <div className="settings-row">
            <span className="settings-row__description settings-warning">{loadError}</span>
          </div>
        ) : null}
        {entries.length === 0 ? (
          <div className="settings-row">
            <span className="settings-row__description">{t("settings.endpoints.noEndpoints")}</span>
          </div>
        ) : (
          entries.map((entry) => (
            <div key={entry.providerId} className="settings-row">
              <div className="settings-row__label">
                <div className="settings-row__title">{entry.providerId}</div>
                <div className="settings-row__description">
                  {entry.baseUrl} ·{" "}
                  {t("settings.endpoints.modelCount", {
                    count: (entry.models ?? []).length,
                    // English pluralizes with the `{s}` marker; Chinese omits it.
                    s: (entry.models ?? []).length === 1 ? "" : "s",
                  })}
                </div>
              </div>
              <div className="settings-row__control">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setDialog({ kind: "edit", original: entry })}
                >
                  {t("settings.endpoints.edit")}
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => void handleDelete(entry.providerId)}
                >
                  {t("common.remove")}
                </button>
              </div>
            </div>
          ))
        )}
        <div className="settings-row">
          <div className="settings-row__label">
            <div className="settings-row__title">{t("settings.endpoints.addEndpoint")}</div>
            <div className="settings-row__description">{t("settings.endpoints.addEndpointHint")}</div>
          </div>
          <div className="settings-row__control">
            <button className="button" type="button" onClick={() => setDialog({ kind: "create" })}>
              {t("settings.endpoints.addEndpoint")}
            </button>
          </div>
        </div>
      </SettingsGroup>

      {dialog.kind !== "closed" ? (
        <CustomEndpointDialog
          mode={dialog}
          existingProviderIds={existingProviderIds}
          onClose={() => setDialog({ kind: "closed" })}
          onSave={handleSave}
        />
      ) : null}
    </>
  );
}

interface CustomEndpointDialogProps {
  readonly mode: Exclude<DialogMode, { kind: "closed" }>;
  readonly existingProviderIds: readonly string[];
  readonly onClose: () => void;
  readonly onSave: (config: CustomProviderConfig) => Promise<string | undefined>;
}

function CustomEndpointDialog({ mode, existingProviderIds, onClose, onSave }: CustomEndpointDialogProps) {
  const { t } = useI18n();
  const initial = mode.kind === "edit" ? mode.original : undefined;
  const [providerId, setProviderId] = useState(initial?.providerId ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [models, setModels] = useState<CustomProviderModelConfig[]>(
    initial ? [...(initial.models ?? [])] : [],
  );
  const [probeCandidates, setProbeCandidates] = useState<readonly string[]>([]);
  const [probeError, setProbeError] = useState<string | undefined>();
  const [probePending, setProbePending] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();
  const [savePending, setSavePending] = useState(false);

  const selectedModelIds = useMemo(() => new Set(models.map((model) => model.id)), [models]);
  const isEdit = mode.kind === "edit";

  const idValidationError = useMemo(
    () => validateProviderId(providerId, existingProviderIds, t, initial?.providerId),
    [providerId, existingProviderIds, t, initial?.providerId],
  );

  const probeModels = useCallback(
    async (
      targetUrl: string,
      targetKey: string,
    ): Promise<{ readonly ok: true; readonly models: readonly string[] } | { readonly ok: false; readonly error: string }> => {
      const api = window.piApp;
      if (!api) {
        return { ok: false, error: t("settings.endpoints.bridgeUnavailable") };
      }
      if (!isValidHttpBaseUrl(targetUrl)) {
        return { ok: false, error: t("settings.endpoints.baseUrlInvalid") };
      }
      return api.probeCustomProviderModels({
        baseUrl: targetUrl.trim(),
        apiKey: targetKey.trim() ? targetKey.trim() : undefined,
      });
    },
    [t],
  );

  const handleProbe = async () => {
    setProbePending(true);
    setProbeError(undefined);
    const result = await probeModels(baseUrl, apiKey);
    setProbePending(false);
    if (!result.ok) {
      setProbeError(result.error);
      setProbeCandidates([]);
      return;
    }
    setProbeCandidates(result.models);
  };

  const toggleModel = (id: string, contextWindow?: number) => {
    setModels((current) => {
      const existing = current.find((model) => model.id === id);
      if (existing) {
        return current.filter((model) => model.id !== id);
      }
      return [...current, contextWindow !== undefined ? { id, contextWindow } : { id }];
    });
  };

  const handleManualAdd = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) {
      return;
    }
    if (selectedModelIds.has(trimmed)) {
      return;
    }
    setModels((current) => [...current, { id: trimmed }]);
  };

  const handleSave = async () => {
    if (idValidationError) {
      setFormError(idValidationError);
      return;
    }
    if (!isValidHttpBaseUrl(baseUrl)) {
      setFormError(t("settings.endpoints.baseUrlInvalid"));
      return;
    }
    setSavePending(true);
    setFormError(undefined);

    // Auto-discover models via GET {baseUrl}/models when none were picked or
    // entered manually. Never write a provider with zero models. Reuse the
    // already-probed candidates (from "Detect models") to avoid a redundant fetch.
    let resolvedModels = models;
    if (resolvedModels.length === 0) {
      if (probeCandidates.length > 0) {
        resolvedModels = probeCandidates.map((id) => ({ id }));
      } else {
        const probeResult = await probeModels(baseUrl, apiKey);
        if (!probeResult.ok) {
          setSavePending(false);
          setFormError(t("settings.endpoints.discoverFailed", { error: probeResult.error }));
          return;
        }
        resolvedModels = probeResult.models.map((id) => ({ id }));
      }
    }

    const error = await onSave({
      providerId: providerId.trim(),
      baseUrl: baseUrl.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      models: resolvedModels,
    });
    if (error) {
      setSavePending(false);
      setFormError(error);
      return;
    }
    onClose();
  };

  return (
    <div className="extension-dialog-backdrop">
      <div
        className="extension-dialog"
        data-testid="custom-endpoint-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !savePending) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="extension-dialog__title">
          {isEdit ? t("settings.endpoints.dialogTitleEdit") : t("settings.endpoints.dialogTitleCreate")}
        </div>
        <p className="extension-dialog__body">{t("settings.endpoints.dialogBody")}</p>
        <label className="settings-field">
          <span>{t("settings.endpoints.providerId")}</span>
          <input
            aria-label={t("settings.endpoints.providerId")}
            autoFocus={!isEdit}
            className="settings-search"
            disabled={isEdit || savePending}
            placeholder={t("settings.endpoints.providerIdPlaceholder")}
            value={providerId}
            onChange={(event) => setProviderId(event.target.value.trim().toLowerCase())}
          />
          {idValidationError ? (
            <span className="settings-row__description settings-warning">{idValidationError}</span>
          ) : (
            <span className="settings-row__description">{t("settings.endpoints.providerIdHint")}</span>
          )}
        </label>
        <label className="settings-field">
          <span>{t("settings.endpoints.baseUrl")}</span>
          <input
            aria-label={t("settings.endpoints.baseUrl")}
            className="settings-search"
            disabled={savePending}
            placeholder={t("settings.endpoints.baseUrlPlaceholder")}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <span className="settings-row__description">{t("settings.endpoints.baseUrlHint")}</span>
        </label>
        <label className="settings-field">
          <span>{t("settings.endpoints.apiKey")}</span>
          <input
            aria-label={t("settings.endpoints.apiKey")}
            className="settings-search"
            disabled={savePending}
            placeholder={t("settings.endpoints.apiKeyPlaceholder")}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <span className="settings-row__description">{t("settings.endpoints.apiKeyHint")}</span>
        </label>

        <div className="settings-field">
          <div className="settings-field__header">
            <span>{t("settings.endpoints.models")}</span>
            <button
              className="button button--secondary"
              disabled={probePending || savePending}
              type="button"
              onClick={() => void handleProbe()}
            >
              {probePending ? t("settings.endpoints.detecting") : t("settings.endpoints.detectModels")}
            </button>
          </div>
          {probeError ? (
            <p className="settings-row__description settings-warning">{probeError}</p>
          ) : null}
          <ModelChecklist
            probed={probeCandidates}
            selected={models}
            onToggle={toggleModel}
            onManualAdd={handleManualAdd}
            disabled={savePending}
          />
          <p className="settings-row__description">{t("settings.endpoints.toolCallingHint")}</p>
        </div>

        {formError ? <p className="extension-dialog__body settings-warning">{formError}</p> : null}
        <div className="extension-dialog__actions">
          <button className="button button--secondary" disabled={savePending} type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="button"
            disabled={savePending || Boolean(idValidationError) || !baseUrl.trim()}
            type="button"
            onClick={() => void handleSave()}
          >
            {isEdit ? t("settings.endpoints.saveChanges") : t("settings.endpoints.addEndpoint")}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ModelChecklistProps {
  readonly probed: readonly string[];
  readonly selected: readonly CustomProviderModelConfig[];
  readonly onToggle: (id: string, contextWindow?: number) => void;
  readonly onManualAdd: (id: string) => void;
  readonly disabled: boolean;
}

function ModelChecklist({ probed, selected, onToggle, onManualAdd, disabled }: ModelChecklistProps) {
  const { t } = useI18n();
  const [manualDraft, setManualDraft] = useState("");
  const selectedIds = useMemo(() => new Set(selected.map((model) => model.id)), [selected]);
  const knownIds = useMemo(() => new Set([...probed, ...selected.map((model) => model.id)]), [probed, selected]);

  const submitManual = () => {
    onManualAdd(manualDraft);
    setManualDraft("");
  };

  return (
    <div className="settings-disclosure__body">
      {knownIds.size === 0 ? (
        <p className="settings-row__description">{t("settings.endpoints.checklistEmpty")}</p>
      ) : (
        <ul className="settings-list">
          {[...knownIds].sort((a, b) => a.localeCompare(b)).map((id) => (
            <li key={id} className="settings-row">
              <label className="settings-row__label">
                <input
                  aria-label={t("settings.endpoints.enableAria", { id })}
                  type="checkbox"
                  checked={selectedIds.has(id)}
                  disabled={disabled}
                  onChange={() => onToggle(id)}
                />
                <span className="settings-row__title">{id}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-row">
        <input
          aria-label={t("settings.endpoints.addModelManually")}
          className="settings-search"
          disabled={disabled}
          placeholder={t("settings.endpoints.addModelManually")}
          value={manualDraft}
          onChange={(event) => setManualDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitManual();
            }
          }}
        />
        <button
          className="button button--secondary"
          disabled={disabled || manualDraft.trim().length === 0}
          type="button"
          onClick={submitManual}
        >
          {t("settings.endpoints.add")}
        </button>
      </div>
    </div>
  );
}

/**
 * Bare function rather than a component, so the translator is passed in — the
 * same pattern `ProviderRow` uses in settings-utils.
 */
function validateProviderId(
  candidate: string,
  existing: readonly string[],
  t: Translator,
  editing?: string,
): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return t("settings.endpoints.providerIdRequired");
  }
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(trimmed)) {
    return t("settings.endpoints.providerIdInvalid");
  }
  if (trimmed !== editing && existing.includes(trimmed)) {
    return t("settings.endpoints.providerIdInUse", { id: trimmed });
  }
  return undefined;
}
