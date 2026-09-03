import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import { buildModelOptions } from "./composer-commands";
import type { Translator } from "./i18n";

export type ModelOnboardingSettingsSection = "models" | "providers";

export interface ModelOnboardingNotice {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly actionSection: ModelOnboardingSettingsSection;
}

export interface ModelOnboardingState {
  readonly hasSelectableModels: boolean;
  readonly requiresModelSelection: boolean;
  readonly unselectedModelLabel: string;
  readonly emptyModelTitle: string;
  readonly emptyModelDescription: string;
  readonly notice?: ModelOnboardingNotice;
}

interface ModelSelectionInput {
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
}

export function deriveModelOnboardingState(
  runtime: RuntimeSnapshot | undefined,
  currentSelection: ModelSelectionInput,
  t: Translator,
): ModelOnboardingState {
  const selectableModels = buildModelOptions(runtime);
  const selectableSet = new Set(selectableModels.map((model) => `${model.providerId}:${model.modelId}`));
  const hasSelectableModels = selectableModels.length > 0;
  const connectedProviderCount = runtime?.providers.filter((provider) => provider.hasAuth).length ?? 0;
  const settingsDefault = {
    provider: runtime?.settings.defaultProvider,
    modelId: runtime?.settings.defaultModelId,
  };
  const hasDefaultModel = Boolean(settingsDefault.provider && settingsDefault.modelId);
  const defaultModelUsable = isUsableSelection(settingsDefault, selectableSet);
  const hasCurrentSelection = Boolean(currentSelection.provider && currentSelection.modelId);
  const currentSelectionUsable = isUsableSelection(currentSelection, selectableSet);

  if (!hasSelectableModels) {
    return {
      hasSelectableModels: false,
      requiresModelSelection: true,
      unselectedModelLabel: t("onboarding.noModels"),
      emptyModelTitle: t("onboarding.noModels"),
      emptyModelDescription:
        connectedProviderCount > 0
          ? t("onboarding.enableModelsHint")
          : t("onboarding.connectProviderHint"),
      notice: connectedProviderCount > 0
        ? {
            title: t("onboarding.noModels"),
            description: t("onboarding.allModelsDisabled"),
            actionLabel: t("onboarding.openModels"),
            actionSection: "models",
          }
        : {
            title: t("onboarding.noModels"),
            description: t("onboarding.connectProviderFirst"),
            actionLabel: t("onboarding.openProviders"),
            actionSection: "providers",
          },
    };
  }

  if (hasCurrentSelection && !currentSelectionUsable) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: true,
      unselectedModelLabel: t("onboarding.pickModel"),
      emptyModelTitle: t("onboarding.noModels"),
      emptyModelDescription: t("onboarding.pickModelHint"),
      notice: {
        title: t("onboarding.selectedModelUnavailable"),
        description: hasDefaultModel
          ? t("onboarding.selectedUnavailableUpdateDefault")
          : t("onboarding.selectedUnavailableChooseDefault"),
        actionLabel: t("onboarding.openModels"),
        actionSection: "models",
      },
    };
  }

  if (!hasDefaultModel) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: t("onboarding.pickModel"),
      emptyModelTitle: t("onboarding.noDefaultModel"),
      emptyModelDescription: t("onboarding.pickModelHint"),
      notice: currentSelectionUsable
        ? undefined
        : {
            title: t("onboarding.noDefaultModel"),
            description: t("onboarding.setDefaultHint"),
            actionLabel: t("onboarding.openModels"),
            actionSection: "models",
          },
    };
  }

  if (!defaultModelUsable) {
    const defaultLabel = `${settingsDefault.provider}:${settingsDefault.modelId}`;
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: t("onboarding.pickModel"),
      emptyModelTitle: t("onboarding.defaultModelUnavailable"),
      emptyModelDescription: t("onboarding.pickModelHint"),
      notice: {
        title: t("onboarding.defaultModelUnavailable"),
        description: currentSelectionUsable
          ? t("onboarding.defaultUnavailableUpdate", { model: defaultLabel })
          : t("onboarding.defaultUnavailableChooseThenUpdate", { model: defaultLabel }),
        actionLabel: t("onboarding.openModels"),
        actionSection: "models",
      },
    };
  }

  return {
    hasSelectableModels: true,
    requiresModelSelection: false,
    unselectedModelLabel: t("onboarding.pickModel"),
    emptyModelTitle: t("onboarding.noModels"),
    emptyModelDescription: t("onboarding.pickModelHint"),
  };
}

function isUsableSelection(
  selection: ModelSelectionInput,
  selectableSet: ReadonlySet<string>,
): boolean {
  return Boolean(selection.provider && selection.modelId && selectableSet.has(`${selection.provider}:${selection.modelId}`));
}
