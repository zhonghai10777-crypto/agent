import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  DefaultPackageManager,
  type CreateModelRuntimeOptions,
  type ResourceLoader,
  type PackageSource,
  SettingsManager,
  parseFrontmatter,
  stripFrontmatter,
  type ExtensionFactory,
  type PathMetadata,
  type ResolvedPaths,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import type {
  RuntimeLoginCallbacks,
  RuntimeExtensionDiagnostic,
  RuntimeExtensionRecord,
  RuntimeModelRecord,
  RuntimeProviderRecord,
  RuntimeResourceDriver,
  RuntimeSettingsSnapshot,
  RuntimeSkillRecord,
  RuntimeSourceInfo,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import { createRuntimeDependencies } from "./runtime-deps.js";
import { createSettingsManagerWithoutNpmPackages, isGlobalNpmLookupError } from "./npm-package-fallback.js";
import { skillSlashCommand } from "./runtime-command-utils.js";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createCompatResourceLoader,
  listAvailableModels,
  listCredentialInfo,
  listModels,
  loginProvider,
  logoutProvider,
  persistApiKey,
  removePersistedApiKey,
  resolveProviderAuth,
} from "./pi-compat/index.js";
import {
  BUILT_IN_PROVIDER_IDS,
  CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
  CustomProviderStore,
  type CustomProviderEntry,
  type CustomProviderInput,
  type CustomProviderSummary,
} from "./custom-provider-store.js";

export {
  BUILT_IN_PROVIDER_IDS,
  CUSTOM_PROVIDER_ID_PATTERN,
  isValidHttpBaseUrl,
  OPENAI_COMPLETIONS_API,
} from "./custom-provider-store.js";
export type {
  CustomProviderEntry,
  CustomProviderInput,
  CustomProviderModelInput,
  CustomProviderSummary,
} from "./custom-provider-store.js";

interface ModelSettingsSnapshot {
  readonly defaultProvider?: string;
  readonly defaultModelId?: string;
  readonly defaultThinkingLevel?: RuntimeSettingsSnapshot["defaultThinkingLevel"];
  readonly enabledModelPatterns: readonly string[];
}

interface RuntimeContext {
  readonly workspace: WorkspaceRef;
  readonly settingsManager: SettingsManager;
  readonly packageManager: DefaultPackageManager;
  readonly resourceLoader: ResourceLoader;
}

export interface RuntimeInlineExtensionMetadata {
  readonly displayName: string;
  readonly description?: string;
}

interface ProjectWritableSettingsManager {
  markProjectModified(field: string, nestedKey?: string): void;
  saveProjectSettings(settings: Record<string, unknown>): void;
}

export interface RuntimeSupervisorOptions {
  readonly agentDir?: string;
  readonly modelRuntime?: ModelRuntime | Promise<ModelRuntime>;
  readonly credentialStore?: CredentialStore;
  readonly modelRegistry?: ModelRegistry | Promise<ModelRegistry>;
  readonly extensionFactories?: readonly ExtensionFactory[];
  readonly inlineExtensionMetadata?: readonly RuntimeInlineExtensionMetadata[];
  readonly customProviderStore?: CustomProviderStore;
  readonly noExtensions?: boolean;
  readonly noSkills?: boolean;
}

type ResourceScope = "user" | "project";
type ToggleableResourceKind = "extension" | "skill";
type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
type AuthInteraction = Parameters<ModelRuntime["login"]>[2];
type AuthPrompt = Parameters<AuthInteraction["prompt"]>[0];
type ProviderAuthStatus = ReturnType<ModelRuntime["getProviderAuthStatus"]>;

interface PackageMetadata {
  readonly displayName?: string;
  readonly description?: string;
}

export class RuntimeSupervisor implements RuntimeResourceDriver {
  private readonly agentDir: string;
  private readonly modelRuntime: Promise<ModelRuntime>;
  private readonly modelRegistry: Promise<ModelRegistry>;
  private readonly extensionFactories: readonly ExtensionFactory[];
  private readonly inlineExtensionMetadata: readonly RuntimeInlineExtensionMetadata[];
  private readonly customProviderStore: CustomProviderStore;
  private readonly noExtensions: boolean;
  private readonly noSkills: boolean;
  private readonly contexts = new Map<string, RuntimeContext>();

  constructor(options: RuntimeSupervisorOptions = {}) {
    const deps = createRuntimeDependencies(options);
    this.agentDir = deps.agentDir;
    this.modelRuntime = deps.modelRuntime;
    this.modelRegistry = deps.modelRegistry;
    this.extensionFactories = options.extensionFactories ?? [];
    this.inlineExtensionMetadata = options.inlineExtensionMetadata ?? [];
    this.customProviderStore = deps.customProviderStore;
    this.noExtensions = options.noExtensions ?? false;
    this.noSkills = options.noSkills ?? false;
  }

  async getRuntimeSnapshot(workspace: WorkspaceRef): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    return this.buildSnapshot(context);
  }

  async imagesAllowed(workspace: WorkspaceRef): Promise<boolean> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.reload();
    return !context.settingsManager.getBlockImages();
  }

  async refreshRuntime(workspace: WorkspaceRef): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.reload();
    const [runtime, registry] = await Promise.all([this.modelRuntime, this.modelRegistry]);
    await runtime.refresh();
    await registry.refresh();
    await context.resourceLoader.reload();
    await this.autoEnableModelsForAuthenticatedProviders(context);
    return this.buildSnapshot(context);
  }

  async login(workspace: WorkspaceRef, providerId: string, callbacks: RuntimeLoginCallbacks): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const [runtime, registry] = await Promise.all([this.modelRuntime, this.modelRegistry]);
    await loginProvider(runtime, providerId, "oauth", toPiAuthInteraction(callbacks));
    await registry.refresh();
    await context.resourceLoader.reload();
    await this.autoEnableModelsForAuthenticatedProviders(context, [providerId]);
    return this.buildSnapshot(context);
  }

  async logout(workspace: WorkspaceRef, providerId: string): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const [runtime, registry] = await Promise.all([this.modelRuntime, this.modelRegistry]);
    await logoutProvider(runtime, providerId);
    await registry.refresh();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async setProviderApiKey(workspace: WorkspaceRef, providerId: string, apiKey: string): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const normalized = apiKey.trim();
    if (!normalized) {
      throw new Error("API key is required.");
    }
    if (!providerSupportsDesktopApiKeySetup(providerId)) {
      throw new Error(`API key setup is not supported for ${providerId}.`);
    }
    const [runtime, registry] = await Promise.all([this.modelRuntime, this.modelRegistry]);
    await persistApiKey(runtime, providerId, normalized);
    await registry.refresh();
    await context.resourceLoader.reload();
    await this.autoEnableModelsForAuthenticatedProviders(context, [providerId]);
    return this.buildSnapshot(context);
  }

  async listCustomProviders(): Promise<readonly CustomProviderSummary[]> {
    const entries = await this.customProviderStore.list();
    const runtime = await this.modelRuntime;
    return Promise.all(
      entries.map(async (entry) => ({
        providerId: entry.providerId,
        baseUrl: entry.baseUrl,
        models: entry.models,
        hasApiKey: await this.hasRealApiKey(runtime, entry),
      })),
    );
  }

  /**
   * Whether a usable credential exists for a custom endpoint.
   *
   * models.json carries the literal placeholder for every managed endpoint and
   * the SDK reports that through `getAuth`, so a placeholder-blind check calls
   * every endpoint "configured" — including one that has no key at all, which is
   * exactly the state the user needs to see.
   */
  private async hasRealApiKey(
    runtime: Awaited<RuntimeSupervisor["modelRuntime"]>,
    entry: CustomProviderEntry,
  ): Promise<boolean> {
    const credential = await resolveProviderAuth(runtime, entry.providerId);
    const key = credential?.auth.apiKey;
    if (typeof key === "string" && key && key !== CUSTOM_PROVIDER_PLACEHOLDER_API_KEY) {
      return true;
    }
    if (credential?.auth.headers) {
      return true;
    }
    // A pre-encryption build may still hold the only copy in models.json.
    return Boolean(entry.apiKey);
  }

  async setCustomProvider(workspace: WorkspaceRef, input: CustomProviderInput): Promise<RuntimeSnapshot> {
    const [runtime, registry] = await Promise.all([this.modelRuntime, this.modelRegistry]);
    const oauthProviderIds = new Set((await listCredentialInfo(runtime)).filter((entry) => entry.type === "oauth").map((entry) => entry.providerId));
    if (BUILT_IN_PROVIDER_IDS.has(input.providerId) || oauthProviderIds.has(input.providerId)) {
      throw new Error(
        `Provider ID "${input.providerId}" conflicts with a built-in provider. Pick a unique ID.`,
      );
    }
    const context = await this.ensureContext(workspace);

    // Rescue a legacy plaintext key *before* the write below replaces it with
    // the placeholder. For such an endpoint models.json holds the only copy, so
    // saving an unrelated edit (a base URL, a model list) would otherwise destroy
    // the credential and leave the runtime authenticating with "unused".
    const existing = (await this.customProviderStore.list()).find(
      (entry) => entry.providerId === input.providerId,
    );
    // An omitted or empty apiKey means "keep what is stored": the renderer never
    // receives the secret, so it has nothing to echo back.
    const incomingKey = input.apiKey?.trim();
    const keyToStore = incomingKey || existing?.apiKey?.trim();

    await this.customProviderStore.set(input);
    // Refresh before storing the key: `login` resolves the provider through the
    // runtime, and a newly written endpoint is not known to it until the model
    // catalog is re-read.
    await registry.refresh();
    // The API key is stored in the (optionally encrypted) auth storage rather
    // than in models.json, so custom-endpoint keys never land in plaintext.
    // Store it under the provider's own id so ModelRuntime resolves it at
    // session time.
    if (keyToStore) {
      await persistApiKey(runtime, input.providerId, keyToStore);
    }
    await context.resourceLoader.reload();
    await this.autoEnableModelsForAuthenticatedProviders(context, [input.providerId]);
    return this.buildSnapshot(context);
  }

  /**
   * The stored credential for a custom endpoint, for callers that must actually
   * authenticate (the "Detect models" probe) rather than just report state.
   */
  async getCustomProviderApiKey(providerId: string): Promise<string | undefined> {
    const runtime = await this.modelRuntime;
    const credential = await resolveProviderAuth(runtime, providerId);
    const key = credential?.auth.apiKey;
    if (typeof key === "string" && key && key !== CUSTOM_PROVIDER_PLACEHOLDER_API_KEY) {
      return key;
    }
    const entry = (await this.customProviderStore.list()).find((item) => item.providerId === providerId);
    return entry?.apiKey?.trim() || undefined;
  }

  async deleteCustomProvider(workspace: WorkspaceRef, providerId: string): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    await this.customProviderStore.delete(providerId);
    const [runtime, registry] = await Promise.all([this.modelRuntime, this.modelRegistry]);
    await removePersistedApiKey(runtime, providerId);
    await registry.refresh();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async setDefaultModel(
    workspace: WorkspaceRef,
    selection: {
      readonly provider: string;
      readonly modelId: string;
    },
  ): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.setDefaultModelAndProvider(selection.provider, selection.modelId);
    await context.settingsManager.flush();
    return this.buildSnapshot(context);
  }

  async setProjectDefaultModel(
    workspace: WorkspaceRef,
    selection: {
      readonly provider: string;
      readonly modelId: string;
    },
  ): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const settingsManager = context.settingsManager as unknown as ProjectWritableSettingsManager;
    const projectSettings = context.settingsManager.getProjectSettings() as Record<string, unknown>;
    projectSettings.defaultProvider = selection.provider;
    projectSettings.defaultModel = selection.modelId;
    settingsManager.markProjectModified("defaultProvider");
    settingsManager.markProjectModified("defaultModel");
    settingsManager.saveProjectSettings(projectSettings);
    await context.settingsManager.flush();
    context.settingsManager.reload();
    return this.buildSnapshot(context);
  }

  async setDefaultThinkingLevel(
    workspace: WorkspaceRef,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    if (!thinkingLevel) {
      throw new Error("Thinking level is required.");
    }
    context.settingsManager.setDefaultThinkingLevel(thinkingLevel);
    await context.settingsManager.flush();
    return this.buildSnapshot(context);
  }

  async setProjectDefaultThinkingLevel(
    workspace: WorkspaceRef,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    if (!thinkingLevel) {
      throw new Error("Thinking level is required.");
    }
    const settingsManager = context.settingsManager as unknown as ProjectWritableSettingsManager;
    const projectSettings = context.settingsManager.getProjectSettings() as Record<string, unknown>;
    projectSettings.defaultThinkingLevel = thinkingLevel;
    settingsManager.markProjectModified("defaultThinkingLevel");
    settingsManager.saveProjectSettings(projectSettings);
    await context.settingsManager.flush();
    context.settingsManager.reload();
    return this.buildSnapshot(context);
  }

  async setEnableSkillCommands(workspace: WorkspaceRef, enabled: boolean): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.setEnableSkillCommands(enabled);
    await context.settingsManager.flush();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async setScopedModelPatterns(workspace: WorkspaceRef, patterns: readonly string[]): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.setEnabledModels(patterns.length > 0 ? [...patterns] : undefined);
    await context.settingsManager.flush();
    return this.buildSnapshot(context);
  }

  async setProjectScopedModelPatterns(workspace: WorkspaceRef, patterns: readonly string[]): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const settingsManager = context.settingsManager as unknown as ProjectWritableSettingsManager;
    const projectSettings = context.settingsManager.getProjectSettings() as Record<string, unknown>;
    projectSettings.enabledModels = patterns.length > 0 ? [...patterns] : undefined;
    settingsManager.markProjectModified("enabledModels");
    settingsManager.saveProjectSettings(projectSettings);
    await context.settingsManager.flush();
    context.settingsManager.reload();
    return this.buildSnapshot(context);
  }

  async getGlobalModelSettings(workspace: WorkspaceRef): Promise<ModelSettingsSnapshot> {
    const context = await this.ensureContext(workspace);
    return toModelSettingsSnapshot(context.settingsManager.getGlobalSettings() as Record<string, unknown>);
  }

  async getCurrentModelSettings(workspace: WorkspaceRef): Promise<ModelSettingsSnapshot> {
    const globalSettings = await readJsonRecord(join(this.agentDir, "settings.json"));
    const projectSettings = await readJsonRecord(join(workspace.path, ".pi", "settings.json"));
    const globalModelSettings = toModelSettingsSnapshot(globalSettings);
    const projectModelSettings = toModelSettingsSnapshot(projectSettings);
    const snapshot: {
      defaultProvider?: string;
      defaultModelId?: string;
      defaultThinkingLevel?: ModelSettingsSnapshot["defaultThinkingLevel"];
      enabledModelPatterns: readonly string[];
    } = {
      enabledModelPatterns: Array.isArray(projectSettings.enabledModels)
        ? projectModelSettings.enabledModelPatterns
        : globalModelSettings.enabledModelPatterns,
    };

    if (Object.prototype.hasOwnProperty.call(projectSettings, "defaultProvider")) {
      if (projectModelSettings.defaultProvider) {
        snapshot.defaultProvider = projectModelSettings.defaultProvider;
      }
    } else if (globalModelSettings.defaultProvider) {
      snapshot.defaultProvider = globalModelSettings.defaultProvider;
    }

    if (Object.prototype.hasOwnProperty.call(projectSettings, "defaultModel")) {
      if (projectModelSettings.defaultModelId) {
        snapshot.defaultModelId = projectModelSettings.defaultModelId;
      }
    } else if (globalModelSettings.defaultModelId) {
      snapshot.defaultModelId = globalModelSettings.defaultModelId;
    }

    if (Object.prototype.hasOwnProperty.call(projectSettings, "defaultThinkingLevel")) {
      if (projectModelSettings.defaultThinkingLevel) {
        snapshot.defaultThinkingLevel = projectModelSettings.defaultThinkingLevel;
      }
    } else if (globalModelSettings.defaultThinkingLevel) {
      snapshot.defaultThinkingLevel = globalModelSettings.defaultThinkingLevel;
    }

    return snapshot;
  }

  async setSkillEnabled(workspace: WorkspaceRef, filePath: string, enabled: boolean): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const resolvedPaths = await this.resolveRuntimePaths(context);
    const resource = resolvedPaths.skills.find((entry) => resolve(entry.path) === resolve(filePath));
    if (!resource) {
      throw new Error(`Unknown skill: ${filePath}`);
    }

    this.toggleResource(context, resource, enabled, "skill");
    await context.settingsManager.flush();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async setExtensionEnabled(workspace: WorkspaceRef, filePath: string, enabled: boolean): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const resolvedPaths = await this.resolveRuntimePaths(context);
    const resource = resolvedPaths.extensions.find((entry) => resolve(entry.path) === resolve(filePath));
    if (!resource) {
      throw new Error(`Unknown extension: ${filePath}`);
    }

    this.toggleResource(context, resource, enabled, "extension");
    await context.settingsManager.flush();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  private async ensureContext(workspace: WorkspaceRef): Promise<RuntimeContext> {
    const existing = this.contexts.get(workspace.workspaceId);
    if (existing) {
      return existing;
    }

    let settingsManager = SettingsManager.create(workspace.path, this.agentDir);
    let packageManager = new DefaultPackageManager({
      cwd: workspace.path,
      agentDir: this.agentDir,
      settingsManager,
    });
    let resourceLoader = createCompatResourceLoader({
      cwd: workspace.path,
      agentDir: this.agentDir,
      settingsManager,
      extensionFactories: [...this.extensionFactories],
      noExtensions: this.noExtensions,
      noSkills: this.noSkills,
    });
    try {
      await resourceLoader.reload();
    } catch (error) {
      if (!isGlobalNpmLookupError(error)) {
        throw error;
      }

      const fallbackSettingsManager = createSettingsManagerWithoutNpmPackages(settingsManager);
      if (!fallbackSettingsManager) {
        throw error;
      }

      console.warn(
        `[pi-gui] Falling back to runtime resource loading without npm package sources for ${workspace.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      settingsManager = fallbackSettingsManager;
      packageManager = new DefaultPackageManager({
        cwd: workspace.path,
        agentDir: this.agentDir,
        settingsManager,
      });
      resourceLoader = createCompatResourceLoader({
        cwd: workspace.path,
        agentDir: this.agentDir,
        settingsManager,
        extensionFactories: [...this.extensionFactories],
        noExtensions: this.noExtensions,
        noSkills: this.noSkills,
      });
      await resourceLoader.reload();
    }

    const context: RuntimeContext = {
      workspace,
      settingsManager,
      packageManager,
      resourceLoader,
    };
    this.contexts.set(workspace.workspaceId, context);
    return context;
  }

  private async buildSnapshot(context: RuntimeContext): Promise<RuntimeSnapshot> {
    const resolvedPaths = await this.resolveRuntimePaths(context);
    const [skills, extensions, providers] = await Promise.all([
      this.buildSkillRecords(context, resolvedPaths.skills),
      this.buildExtensionRecords(context, resolvedPaths.extensions),
      this.buildProviderRecords(),
    ]);
    const models = await this.buildModelRecords(providers);

    const defaultProvider = context.settingsManager.getDefaultProvider();
    const defaultModelId = context.settingsManager.getDefaultModel();
    const defaultThinkingLevel = context.settingsManager.getDefaultThinkingLevel();
    const settings: RuntimeSettingsSnapshot = {
      ...(defaultProvider ? { defaultProvider } : {}),
      ...(defaultModelId ? { defaultModelId } : {}),
      ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
      enableSkillCommands: context.settingsManager.getEnableSkillCommands(),
      enabledModelPatterns: context.settingsManager.getEnabledModels() ?? [],
    };

    return {
      workspace: context.workspace,
      providers,
      models,
      skills,
      extensions,
      settings,
    };
  }

  private async resolveRuntimePaths(context: RuntimeContext): Promise<ResolvedPaths> {
    try {
      return await context.packageManager.resolve();
    } catch (error) {
      if (!isGlobalNpmLookupError(error)) {
        throw error;
      }

      const fallbackSettingsManager = createSettingsManagerWithoutNpmPackages(context.settingsManager);
      if (!fallbackSettingsManager) {
        throw error;
      }

      console.warn(
        `[pi-gui] Falling back to runtime package resolution without npm package sources for ${context.workspace.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      const fallbackPackageManager = new DefaultPackageManager({
        cwd: context.workspace.path,
        agentDir: this.agentDir,
        settingsManager: fallbackSettingsManager,
      });
      return fallbackPackageManager.resolve();
    }
  }

  private async buildProviderRecords(): Promise<readonly RuntimeProviderRecord[]> {
    // Only custom OpenAI-compatible endpoints are surfaced. Built-in providers
    // (anthropic, openai, OAuth like GitHub Copilot) and their catalog of 1000+
    // hardcoded models stay out of the desktop UI; the runtime still resolves
    // them through ModelRegistry for any sessions that reference them.
    const customProviderIds = new Set(
      (await this.customProviderStore.list()).map((entry) => entry.providerId),
    );
    const [runtime, registry] = await Promise.all([this.modelRuntime, this.modelRegistry]);
    const credentials = await listCredentialInfo(runtime);
    const credentialByProvider = new Map(credentials.map((credential) => [credential.providerId, credential]));
    const oauthProviderIds = new Set(credentials.filter((credential) => credential.type === "oauth").map((credential) => credential.providerId));

    return [...customProviderIds]
      .filter((providerId) => !oauthProviderIds.has(providerId))
      .sort((left, right) => left.localeCompare(right))
      .map((providerId) => {
        const credential = credentialByProvider.get(providerId);
        const apiKeySetupSupported = providerSupportsDesktopApiKeySetup(providerId);
        const providerAuthStatus = registry.getProviderAuthStatus(providerId);
        const hasAuth = providerAuthStatus.configured || Boolean(credential);
        return {
          id: providerId,
          name: providerId,
          hasAuth,
          authType: credential?.type ?? "none",
          authSource: inferProviderAuthSource(credential?.type, providerAuthStatus, apiKeySetupSupported),
          oauthSupported: false,
          apiKeySetupSupported,
        };
      });
  }

  private async buildModelRecords(
    providers: readonly RuntimeProviderRecord[],
  ): Promise<readonly RuntimeModelRecord[]> {
    const [runtime, registry] = await Promise.all([this.modelRuntime, this.modelRegistry]);
    await registry.refresh();
    // Use the runtime's synchronous availability snapshot for UI projection.
    // `getAvailable()` may perform provider network checks and transiently
    // hide otherwise configured custom models while an endpoint is offline.
    const availableKeys = new Set(
      listAvailableModels(runtime).map((model) => `${model.provider}:${model.id}`),
    );
    const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
    const customProviderIds = new Set(providerMap.keys());

    return listModels(runtime)
      .filter((model) => customProviderIds.has(model.provider))
      .map<RuntimeModelRecord>((model) => {
        const provider = providerMap.get(model.provider);
        return {
          providerId: model.provider,
          providerName: provider?.name ?? model.provider,
          modelId: model.id,
          label: model.name,
          available: availableKeys.has(`${model.provider}:${model.id}`),
          authType: provider?.authType ?? "none",
          reasoning: Boolean(model.reasoning),
          supportsImages: model.input.includes("image"),
        };
      })
      .sort((left, right) =>
        left.providerId === right.providerId
          ? left.modelId.localeCompare(right.modelId)
          : left.providerId.localeCompare(right.providerId),
      );
  }

  private async autoEnableModelsForAuthenticatedProviders(
    context: RuntimeContext,
    providerIds?: readonly string[],
  ): Promise<void> {
    const currentPatterns = context.settingsManager.getEnabledModels() ?? [];
    if (currentPatterns.length === 0) {
      return;
    }

    const providers = await this.buildProviderRecords();
    const models = await this.buildModelRecords(providers);
    const hasSelectableModels = models.some((model) =>
      model.available && currentPatterns.includes(`${model.providerId}/${model.modelId}`),
    );
    const candidateProviderIds =
      providerIds && providerIds.length > 0
        ? providerIds
        : hasSelectableModels
          ? []
          : providers
              .filter((provider) => provider.hasAuth)
              .map((provider) => provider.id);
    if (candidateProviderIds.length === 0) {
      return;
    }

    const candidateProviderSet = new Set(candidateProviderIds);
    const nextPatterns = mergeEnabledModelPatterns(
      currentPatterns,
      models
        .filter((model) => model.available && candidateProviderSet.has(model.providerId))
        .map((model) => `${model.providerId}/${model.modelId}`),
    );
    if (nextPatterns.length === currentPatterns.length) {
      return;
    }

    context.settingsManager.setEnabledModels([...nextPatterns]);
    await context.settingsManager.flush();
  }

  private async buildSkillRecords(
    context: RuntimeContext,
    resolvedSkills: readonly ResolvedResource[],
  ): Promise<readonly RuntimeSkillRecord[]> {
    const loadedSkills = new Map(
      context.resourceLoader
        .getSkills()
        .skills.map((skill) => [resolve(skill.filePath), skill] as const),
    );

    const records = await Promise.all(
      resolvedSkills.map(async (resource) => {
        const filePath = resolve(resource.path);
        const loaded = loadedSkills.get(filePath);
        const fallback = loaded ? undefined : await readSkillMetadata(filePath);
        const name = loaded?.name ?? fallback?.name ?? inferSkillName(filePath);
        const description = loaded?.description ?? fallback?.description ?? "No description provided.";
        const disableModelInvocation = loaded?.disableModelInvocation ?? fallback?.disableModelInvocation ?? false;

        return {
          name,
          description,
          filePath,
          baseDir: loaded?.baseDir ?? dirname(filePath),
          source: resource.metadata.source,
          enabled: resource.enabled,
          disableModelInvocation,
          slashCommand: skillSlashCommand(name),
        } satisfies RuntimeSkillRecord;
      }),
    );

    return records.sort((left: RuntimeSkillRecord, right: RuntimeSkillRecord) => left.name.localeCompare(right.name));
  }

  private async buildExtensionRecords(
    context: RuntimeContext,
    resolvedExtensions: readonly ResolvedResource[],
  ): Promise<readonly RuntimeExtensionRecord[]> {
    const loadedResult = context.resourceLoader.getExtensions();
    const packageMetadataCache = new Map<string, Promise<PackageMetadata>>();
    const loadedByPath = new Map(
      loadedResult.extensions.map((extension) => [resolve(extension.resolvedPath || extension.path), extension] as const),
    );
    const diagnosticsByPath = new Map<string, RuntimeExtensionDiagnostic[]>();

    for (const error of loadedResult.errors) {
      const diagnostics = diagnosticsByPath.get(resolve(error.path)) ?? [];
      diagnostics.push({
        type: "error",
        message: error.error,
        path: error.path,
      });
      diagnosticsByPath.set(resolve(error.path), diagnostics);
    }

    const records = await Promise.all(
      resolvedExtensions.map<Promise<RuntimeExtensionRecord>>(async (resource) => {
        const path = resolve(resource.path);
        const loaded = loadedByPath.get(path);
        const packageMetadata = await inferExtensionPackageMetadata(resource.metadata, packageMetadataCache);
        return {
          path,
          displayName: packageMetadata?.displayName ?? inferExtensionEntryName(path),
          ...(packageMetadata?.description ? { description: packageMetadata.description } : {}),
          enabled: resource.enabled,
          sourceInfo: toRuntimeSourceInfo(path, resource.metadata),
          commands: loaded ? [...loaded.commands.keys()].sort((left, right) => left.localeCompare(right)) : [],
          tools: loaded
            ? [...loaded.tools.values()]
                .map((tool) => tool.definition.name)
                .sort((left, right) => left.localeCompare(right))
            : [],
          flags: loaded ? [...loaded.flags.keys()].sort((left, right) => left.localeCompare(right)) : [],
          shortcuts: loaded ? [...loaded.shortcuts.keys()].sort((left, right) => left.localeCompare(right)) : [],
          diagnostics: diagnosticsByPath.get(path) ?? [],
        };
      }),
    );
    const resolvedRecordPaths = new Set(records.map((record) => resolve(record.path)));
    const inlineRecords = loadedResult.extensions
      .filter((extension) => extension.path.startsWith("<inline:") && !resolvedRecordPaths.has(resolve(extension.path)))
      .map((extension) => this.buildInlineExtensionRecord(extension));
    records.push(...inlineRecords);

    return records.sort((left, right) =>
      left.displayName === right.displayName
        ? left.path.localeCompare(right.path)
        : left.displayName.localeCompare(right.displayName),
    );
  }

  private buildInlineExtensionRecord(extension: ReturnType<ResourceLoader["getExtensions"]>["extensions"][number]): RuntimeExtensionRecord {
    const metadata = inlineExtensionMetadataForPath(extension.path, this.inlineExtensionMetadata);
    return {
      path: extension.path,
      displayName: metadata.displayName,
      ...(metadata.description ? { description: metadata.description } : {}),
      enabled: true,
      sourceInfo: {
        path: extension.path,
        source: "builtin",
        scope: "temporary",
        origin: "top-level",
      },
      commands: [...extension.commands.keys()].sort((left, right) => left.localeCompare(right)),
      tools: [...extension.tools.values()]
        .map((tool) => tool.definition.name)
        .sort((left, right) => left.localeCompare(right)),
      flags: [...extension.flags.keys()].sort((left, right) => left.localeCompare(right)),
      shortcuts: [...extension.shortcuts.keys()].sort((left, right) => left.localeCompare(right)),
      diagnostics: [],
    };
  }

  private toggleResource(
    context: RuntimeContext,
    resource: ResolvedResource,
    enabled: boolean,
    kind: ToggleableResourceKind,
  ): void {
    const { settingsManager } = context;
    const scope = resource.metadata.scope;
    if (scope !== "project" && scope !== "user") {
      throw new Error(`Cannot update ${kind} at scope ${scope}`);
    }
    const origin = resource.metadata.origin;
    const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
    const pattern = this.relativeResourcePattern(resource.path, resource.metadata, scope, origin);

    if (origin === "top-level") {
      const currentPaths = kind === "skill" ? [...(settings.skills ?? [])] : [...(settings.extensions ?? [])];
      const updated = replaceResourcePattern(currentPaths, pattern, enabled);
      this.setTopLevelResourcePaths(settingsManager, scope, kind, updated);
      return;
    }

    const packages = [...(settings.packages ?? [])];
    const source = resource.metadata.source;
    const packageIndex = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === source);
    if (packageIndex < 0) {
      throw new Error(`${titleForResourceKind(kind)} package source not found for ${resource.path}`);
    }

    const currentPackage = packages[packageIndex];
    const nextPackage = typeof currentPackage === "string" ? { source: currentPackage } : { ...currentPackage };
    const currentPatterns = kind === "skill" ? [...(nextPackage.skills ?? [])] : [...(nextPackage.extensions ?? [])];
    const updatedPatterns = replaceResourcePattern(currentPatterns, pattern, enabled);
    if (updatedPatterns.length > 0) {
      if (kind === "skill") {
        nextPackage.skills = updatedPatterns;
      } else {
        nextPackage.extensions = updatedPatterns;
      }
    } else {
      if (kind === "skill") {
        delete nextPackage.skills;
      } else {
        delete nextPackage.extensions;
      }
    }

    const hasFilters = ["skills", "extensions", "prompts", "themes"].some((key) =>
      Object.prototype.hasOwnProperty.call(nextPackage, key),
    );
    packages[packageIndex] = (hasFilters ? nextPackage : nextPackage.source) as PackageSource;

    if (scope === "project") {
      settingsManager.setProjectPackages(packages);
    } else {
      settingsManager.setPackages(packages);
    }
  }

  private setTopLevelResourcePaths(
    settingsManager: SettingsManager,
    scope: ResourceScope,
    kind: ToggleableResourceKind,
    paths: string[],
  ): void {
    if (kind === "skill") {
      if (scope === "project") {
        settingsManager.setProjectSkillPaths(paths);
      } else {
        settingsManager.setSkillPaths(paths);
      }
      return;
    }

    if (scope === "project") {
      settingsManager.setProjectExtensionPaths(paths);
    } else {
      settingsManager.setExtensionPaths(paths);
    }
  }

  private relativeResourcePattern(
    filePath: string,
    metadata: PathMetadata,
    scope: ResourceScope,
    origin: PathMetadata["origin"],
  ): string {
    if (origin === "package") {
      const baseDir = metadata.baseDir ?? dirname(filePath);
      return relative(baseDir, filePath);
    }

    const baseDir = metadata.baseDir ?? (scope === "project" ? dirname(filePath) : this.agentDir);
    return relative(baseDir, filePath);
  }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function replaceResourcePattern(patterns: readonly string[], resourcePattern: string, enabled: boolean): string[] {
  const next = patterns.filter((pattern) => stripPrefix(pattern) !== resourcePattern);
  next.push(`${enabled ? "+" : "-"}${resourcePattern}`);
  return next;
}

function stripPrefix(pattern: string): string {
  return pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!") ? pattern.slice(1) : pattern;
}

async function readSkillMetadata(
  filePath: string,
): Promise<{ name?: string; description?: string; disableModelInvocation?: boolean } | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const frontmatter = parseFrontmatter(raw) as
      | {
          name?: string;
          description?: string;
          "disable-model-invocation"?: boolean;
        }
      | undefined;
    const body = stripFrontmatter(raw);
    const metadata: { name?: string; description?: string; disableModelInvocation?: boolean } = {};
    if (frontmatter?.name) {
      metadata.name = frontmatter.name;
    }
    const description = frontmatter?.description ?? firstNonEmptyLine(body);
    if (description) {
      metadata.description = description;
    }
    if (frontmatter?.["disable-model-invocation"] !== undefined) {
      metadata.disableModelInvocation = frontmatter["disable-model-invocation"];
    }
    return metadata;
  } catch {
    return undefined;
  }
}

function inferSkillName(filePath: string): string {
  const parent = basename(dirname(filePath));
  if (basename(filePath).toLowerCase() === "skill.md" && parent) {
    return parent;
  }
  return basename(filePath).replace(/\.md$/i, "");
}

async function inferExtensionPackageMetadata(
  metadata: PathMetadata,
  packageMetadataCache: Map<string, Promise<PackageMetadata>>,
): Promise<PackageMetadata | undefined> {
  if (metadata.origin === "package" && metadata.baseDir) {
    return inferPackageMetadata(metadata.baseDir, packageMetadataCache);
  }
  return undefined;
}

function inferExtensionEntryName(filePath: string): string {
  return basename(filePath).replace(/\.(c|m)?(t|j)sx?$/i, "");
}

async function inferPackageMetadata(
  packageRoot: string,
  packageMetadataCache: Map<string, Promise<PackageMetadata>>,
): Promise<PackageMetadata> {
  const normalizedRoot = resolve(packageRoot);
  const cached = packageMetadataCache.get(normalizedRoot);
  if (cached) {
    return cached;
  }

  const pending = readPackageMetadata(normalizedRoot);
  packageMetadataCache.set(normalizedRoot, pending);
  return pending;
}

async function readPackageMetadata(packageRoot: string): Promise<PackageMetadata> {
  const folderName = basename(packageRoot).trim();
  const packageJson = await readJsonRecord(join(packageRoot, "package.json")) as {
    readonly displayName?: unknown;
    readonly description?: unknown;
  };
  const displayName =
    typeof packageJson.displayName === "string" && packageJson.displayName.trim()
      ? packageJson.displayName.trim()
      : folderName;
  const description =
    typeof packageJson.description === "string" && packageJson.description.trim()
      ? packageJson.description.trim()
      : undefined;

  return {
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
  };
}

/** Sentinel the UI receives for a stored custom-endpoint key (never the real value). */

const DESKTOP_API_KEY_PROVIDER_IDS = new Set([
  "azure-openai-responses",
  "cerebras",
  "google",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "zai",
]);

function providerSupportsDesktopApiKeySetup(providerId: string): boolean {
  return DESKTOP_API_KEY_PROVIDER_IDS.has(providerId);
}

function toPiAuthInteraction(callbacks: RuntimeLoginCallbacks): AuthInteraction {
  return {
    ...(callbacks.signal ? { signal: callbacks.signal } : {}),
    prompt: async (prompt: AuthPrompt) => {
      if (prompt.type === "select") {
        const choice = await callbacks.onPrompt({
          message: `${prompt.message}\n${prompt.options.map((option, index) => `${index + 1}. ${option.label}`).join("\n")}`,
          allowEmpty: true,
          ...(prompt.options[0] ? { placeholder: prompt.options[0].label } : {}),
        });
        const normalized = choice.trim();
        if (!normalized) return prompt.options[0]?.id ?? "";
        const index = Number.parseInt(normalized, 10);
        return Number.isInteger(index) && index >= 1 && index <= prompt.options.length
          ? prompt.options[index - 1]?.id ?? normalized
          : prompt.options.find((option) => option.id === normalized || option.label === normalized)?.id ?? normalized;
      }
      if (prompt.type === "manual_code" && callbacks.onManualCodeInput) {
        return callbacks.onManualCodeInput();
      }
      return callbacks.onPrompt({ message: prompt.message, ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}), ...(prompt.type === "secret" ? {} : { allowEmpty: true }) });
    },
    notify: (event) => {
      if (event.type === "auth_url") {
        void callbacks.onAuth({ url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) });
      } else if (event.type === "device_code") {
        void callbacks.onAuth({ url: event.verificationUri, instructions: `Enter code: ${event.userCode}` });
      } else if (event.type === "progress" && callbacks.onProgress) {
        void callbacks.onProgress(event.message);
      } else if (event.type === "info" && callbacks.onProgress) {
        void callbacks.onProgress(event.message);
      }
    },
  };
}

function inferProviderAuthSource(
  auth: "oauth" | "api_key" | undefined,
  providerAuthStatus: ProviderAuthStatus,
  apiKeySetupSupported: boolean,
): "none" | "oauth" | "auth_file" | "env" | "external" {
  if (auth === "oauth") {
    return "oauth";
  }
  if (auth === "api_key") {
    return "auth_file";
  }
  switch (providerAuthStatus.source) {
    case "stored":
      return "auth_file";
    case "environment":
      return "env";
    case "fallback":
    case "models_json_command":
    case "models_json_key":
    case "runtime":
      return "external";
  }
  if (!providerAuthStatus.configured) {
    return "none";
  }
  return apiKeySetupSupported ? "env" : "external";
}

function toRuntimeSourceInfo(path: string, metadata: PathMetadata): RuntimeSourceInfo {
  return {
    path,
    source: metadata.source,
    scope: metadata.scope,
    origin: metadata.origin,
    ...(metadata.baseDir ? { baseDir: metadata.baseDir } : {}),
  };
}

function inlineExtensionMetadataForPath(
  path: string,
  metadata: readonly RuntimeInlineExtensionMetadata[],
): RuntimeInlineExtensionMetadata {
  const match = /^<inline:(\d+)>$/.exec(path);
  const index = match?.[1] ? Number.parseInt(match[1], 10) - 1 : -1;
  return metadata[index] ?? { displayName: path };
}

function titleForResourceKind(kind: ToggleableResourceKind): string {
  return kind === "skill" ? "Skill" : "Extension";
}

function toModelSettingsSnapshot(settings: Record<string, unknown>): ModelSettingsSnapshot {
  return {
    enabledModelPatterns: Array.isArray(settings.enabledModels)
      ? settings.enabledModels.filter((value): value is string => typeof value === "string")
      : [],
    ...(typeof settings.defaultProvider === "string" ? { defaultProvider: settings.defaultProvider } : {}),
    ...(typeof settings.defaultModel === "string" ? { defaultModelId: settings.defaultModel } : {}),
    ...(typeof settings.defaultThinkingLevel === "string"
      ? { defaultThinkingLevel: settings.defaultThinkingLevel as ModelSettingsSnapshot["defaultThinkingLevel"] }
      : {}),
  } satisfies ModelSettingsSnapshot;
}

function mergeEnabledModelPatterns(
  existingPatterns: readonly string[],
  providerPatterns: readonly string[],
): readonly string[] {
  const merged = [...existingPatterns];
  const seen = new Set(existingPatterns);
  for (const pattern of providerPatterns) {
    if (seen.has(pattern)) {
      continue;
    }
    seen.add(pattern);
    merged.push(pattern);
  }
  return merged;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}
