import type { SessionConfig } from "@pi-gui/session-driver";
import type {
  RuntimeCommandRecord,
  RuntimeProviderRecord,
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type { ExtensionCommandCompatibilityRecord } from "./desktop-state";
import { tGlobal, type MessageKey, type Translator } from "./i18n";
import { titleCase } from "./string-utils";

export type ComposerSlashCommandKind =
  | "runtime"
  | "model"
  | "thinking"
  | "tree"
  | "status"
  | "session"
  | "reload"
  | "compact"
  | "name"
  | "login"
  | "logout"
  | "settings"
  | "scoped-models";

export interface ComposerSlashCommand {
  readonly id: string;
  readonly kind: ComposerSlashCommandKind;
  readonly command: string;
  readonly template: string;
  readonly title: string;
  readonly description: string;
  readonly submitMode?: "immediate" | "prefill" | "pick-option";
  readonly section: "runtime" | "host";
  readonly runtimeCommand?: RuntimeCommandRecord;
  readonly sourceLabel?: string;
  readonly compatibility?: ExtensionCommandCompatibilityRecord;
}

export interface ComposerSlashCommandSection {
  readonly id: "runtime" | "host";
  readonly title?: string;
  readonly items: readonly ComposerSlashCommand[];
}

export interface ComposerSlashOption {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

export interface ComposerSlashOptionEmptyState {
  readonly title: string;
  readonly description: string;
}

export interface ComposerModelOption extends ComposerSlashOption {
  readonly providerId: string;
  readonly modelId: string;
}

export interface ComposerProviderOption extends ComposerSlashOption {
  readonly providerId: string;
}

export type ParsedComposerCommand =
  | { type: "model"; provider: string; modelId: string }
  | { type: "thinking"; thinkingLevel: string }
  | { type: "tree" }
  | { type: "status" }
  | { type: "session" }
  | { type: "reload" }
  | { type: "compact"; customInstructions?: string }
  | { type: "name"; title: string };

const INCOMPLETE_COMMAND_MESSAGES: Readonly<Record<string, MessageKey>> = {
  "/compact": "slash.incomplete.compact",
  "/login": "slash.incomplete.login",
  "/logout": "slash.incomplete.logout",
  "/model": "slash.incomplete.model",
  "/name": "slash.incomplete.name",
  "/scoped-models": "slash.incomplete.scopedModels",
  "/settings": "slash.incomplete.settings",
  "/thinking": "slash.incomplete.thinking",
} as const;

/**
 * The `/command` token stays English: it is what the user types and what the
 * runtime parses. Only the title and description shown beside it are localized,
 * so the table is built per call with the active translator.
 */
function hostActionSlashCommands(t: Translator): readonly ComposerSlashCommand[] {
  return [
    {
      id: "host:model",
      kind: "model",
      command: "/model",
      template: "/model",
      title: t("slash.model"),
      description: t("slash.modelDesc"),
      submitMode: "pick-option",
      section: "host",
    },
    {
      id: "host:thinking",
      kind: "thinking",
      command: "/thinking",
      template: "/thinking",
      title: t("slash.thinking"),
      description: t("slash.thinkingDesc"),
      submitMode: "pick-option",
      section: "host",
    },
    {
      id: "host:tree",
      kind: "tree",
      command: "/tree",
      template: "/tree",
      title: t("slash.tree"),
      description: t("slash.treeDesc"),
      submitMode: "immediate",
      section: "host",
    },
    {
      id: "host:status",
      kind: "status",
      command: "/status",
      template: "/status",
      title: t("slash.status"),
      description: t("slash.statusDesc"),
      submitMode: "immediate",
      section: "host",
    },
    {
      id: "host:login",
      kind: "login",
      command: "/login",
      template: "/login",
      title: t("slash.login"),
      description: t("slash.loginDesc"),
      submitMode: "pick-option",
      section: "host",
    },
    {
      id: "host:logout",
      kind: "logout",
      command: "/logout",
      template: "/logout",
      title: t("slash.logout"),
      description: t("slash.logoutDesc"),
      submitMode: "pick-option",
      section: "host",
    },
    {
      id: "host:settings",
      kind: "settings",
      command: "/settings",
      template: "/settings",
      title: t("slash.settings"),
      description: t("slash.settingsDesc"),
      submitMode: "immediate",
      section: "host",
    },
    {
      id: "host:scoped-models",
      kind: "scoped-models",
      command: "/scoped-models",
      template: "/scoped-models",
      title: t("slash.scopedModels"),
      description: t("slash.scopedModelsDesc"),
      submitMode: "immediate",
      section: "host",
    },
    {
      id: "host:session",
      kind: "session",
      command: "/session",
      template: "/session",
      title: t("slash.session"),
      description: t("slash.sessionDesc"),
      submitMode: "immediate",
      section: "host",
    },
    {
      id: "host:name",
      kind: "name",
      command: "/name",
      template: t("slash.nameTemplate"),
      title: t("slash.name"),
      description: t("slash.nameDesc"),
      submitMode: "prefill",
      section: "host",
    },
    {
      id: "host:compact",
      kind: "compact",
      command: "/compact",
      template: "/compact",
      title: t("slash.compact"),
      description: t("slash.compactDesc"),
      submitMode: "immediate",
      section: "host",
    },
    {
      id: "host:reload",
      kind: "reload",
      command: "/reload",
      template: "/reload",
      title: t("slash.reload"),
      description: t("slash.reloadDesc"),
      submitMode: "immediate",
      section: "host",
    },
  ];
}

export function thinkingOptions(t: Translator): readonly ComposerSlashOption[] {
  return [
    { value: "low", label: t("thinking.low"), description: t("thinking.lowDesc") },
    { value: "medium", label: t("thinking.medium"), description: t("thinking.mediumDesc") },
    { value: "high", label: t("thinking.high"), description: t("thinking.highDesc") },
    { value: "xhigh", label: t("thinking.xhigh"), description: t("thinking.xhighDesc") },
    { value: "max", label: t("thinking.max"), description: t("thinking.maxDesc") },
  ];
}

export function buildSlashCommandSections(
  query: string,
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[],
  compatibilityRecords: readonly ExtensionCommandCompatibilityRecord[] = [],
  options: {
    readonly allowTreeCommand?: boolean;
  } = {},
  t: Translator = tGlobal,
): readonly ComposerSlashCommandSection[] {
  const normalizedQuery = query.trim().toLowerCase();
  const availableRuntimeCommands = resolveRuntimeCommands(runtime, sessionCommands);
  const compatibilityByKey = new Map(
    compatibilityRecords.map((record) => [`${record.extensionPath}::${record.commandName}`, record] as const),
  );
  const runtimeMatches = availableRuntimeCommands
    .map<ComposerSlashCommand>((command) => ({
      id: `runtime:${command.source}:${command.name}`,
      kind: "runtime",
      command: `/${command.name}`,
      template: `/${command.name} `,
      title: formatRuntimeCommandTitle(command),
      description: formatRuntimeCommandDescription(command),
      submitMode: "prefill",
      section: "runtime",
      runtimeCommand: command,
      sourceLabel: formatRuntimeSourceLabel(command),
      compatibility: compatibilityByKey.get(`${command.sourceInfo.path}::${command.name}`),
    }))
    .filter((command) => matchesCommand(command, normalizedQuery));
  const allowTreeCommand = options.allowTreeCommand ?? true;
  const hostMatches = hostActionSlashCommands(t).filter(
    (command) => (allowTreeCommand || command.kind !== "tree") && matchesCommand(command, normalizedQuery),
  );

  // Prefer a host action when it is a prefix match and runtime skills only
  // match fuzzily. Otherwise an installed skill such as `observe-state` can
  // steal `/stat` from the built-in `/status` command on Tab.
  const hostHasPrefixMatch = hostMatches.some((command) =>
    command.command.toLowerCase().startsWith(normalizedQuery),
  );
  const runtimeHasPrefixMatch = runtimeMatches.some((command) =>
    command.command.toLowerCase().startsWith(normalizedQuery),
  );
  const runtimeSection: ComposerSlashCommandSection = {
    id: "runtime",
    title: runtimeMatches.length > 0 ? t("slash.section.runtime") : undefined,
    items: runtimeMatches,
  };
  const hostSection: ComposerSlashCommandSection = {
    id: "host",
    title: hostMatches.length > 0 ? t("slash.section.host") : undefined,
    items: hostMatches,
  };
  const sections: ComposerSlashCommandSection[] =
    hostHasPrefixMatch && !runtimeHasPrefixMatch
      ? [hostSection, runtimeSection]
      : [runtimeSection, hostSection];

  return sections.filter((section) => section.items.length > 0);
}

export function resolveRuntimeCommands(
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[],
): readonly RuntimeCommandRecord[] {
  if (!runtime) {
    return sessionCommands;
  }

  const baseCommands = runtime.settings.enableSkillCommands
    ? sessionCommands
    : sessionCommands.filter((command) => command.source !== "skill");
  if (!runtime.settings.enableSkillCommands) {
    return baseCommands;
  }

  const merged = [...baseCommands];
  const seenNames = new Set(baseCommands.map((command) => command.name));
  for (const skill of runtime.skills) {
    if (!skill.enabled) {
      continue;
    }

    const commandName = normalizeRuntimeCommandName(skill.slashCommand);
    if (seenNames.has(commandName)) {
      continue;
    }

    seenNames.add(commandName);
    merged.push({
      name: commandName,
      description: skill.description,
      source: "skill",
      sourceInfo: {
        path: skill.filePath,
        source: skill.source,
        scope: skill.filePath.startsWith(runtime.workspace.path) ? "project" : "user",
        origin: "top-level",
        baseDir: skill.baseDir,
      },
    });
  }

  return merged;
}

export function hasRuntimeSlashCommand(
  text: string,
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[],
): boolean {
  return Boolean(resolveRuntimeSlashCommand(text, runtime, sessionCommands));
}

export function resolveRuntimeSlashCommand(
  text: string,
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[],
): RuntimeCommandRecord | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const spaceIndex = trimmed.indexOf(" ");
  const commandName = normalizeRuntimeCommandName(spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex));
  return resolveRuntimeCommands(runtime, sessionCommands).find((command) => command.name === commandName);
}

function normalizeRuntimeCommandName(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

export function flattenSlashSections(
  sections: readonly ComposerSlashCommandSection[],
): readonly ComposerSlashCommand[] {
  return sections.flatMap((section) => section.items);
}

export function buildProviderOptions(
  providers: readonly RuntimeProviderRecord[],
  filter: (provider: RuntimeProviderRecord) => boolean = () => true,
): readonly ComposerProviderOption[] {
  return providers
    .filter(filter)
    .sort(compareProviders)
    .map((provider) => ({
      value: provider.id,
      label: provider.name,
      description: describeProvider(provider),
      providerId: provider.id,
    }));
}

export function buildModelOptions(
  runtime: RuntimeSnapshot | undefined,
): readonly ComposerModelOption[] {
  if (!runtime) {
    return [];
  }

  const enabledPatterns = runtime.settings.enabledModelPatterns;
  const allAvailable = enabledPatterns.length === 0;
  const enabledSet = allAvailable ? undefined : new Set(enabledPatterns);

  return [...runtime.models]
    .filter((model) => {
      if (!model.available) return false;
      if (!enabledSet) return true;
      return enabledSet.has(`${model.providerId}/${model.modelId}`);
    })
    .sort((left: RuntimeSnapshot["models"][number], right: RuntimeSnapshot["models"][number]) => {
      const providerCompare =
        providerRankForId(runtime.providers, left.providerId) - providerRankForId(runtime.providers, right.providerId);
      if (providerCompare !== 0) {
        return providerCompare;
      }
      return `${left.providerName} ${left.label}`.localeCompare(`${right.providerName} ${right.label}`);
    })
    .map((model: RuntimeSnapshot["models"][number]) => ({
      value: model.modelId,
      label: `${model.providerName} · ${model.label}`,
      description: model.modelId,
      providerId: model.providerId,
      modelId: model.modelId,
    }));
}

export function slashOptionsForCommand(
  command: ComposerSlashCommand | undefined,
  runtime?: RuntimeSnapshot,
  t: Translator = tGlobal,
): readonly ComposerSlashOption[] {
  if (!command) {
    return [];
  }

  if (command.kind === "thinking") {
    return thinkingOptions(t);
  }
  if (command.kind === "model") {
    return buildModelOptions(runtime);
  }
  if (command.kind === "login") {
    return buildProviderOptions(runtime?.providers ?? [], (provider) => provider.oauthSupported);
  }
  if (command.kind === "logout") {
    return buildProviderOptions(
      runtime?.providers ?? [],
      (provider) => provider.authSource === "oauth" || provider.authSource === "auth_file",
    );
  }

  return [];
}

export function slashOptionEmptyState(
  command: ComposerSlashCommand | undefined,
  runtime?: RuntimeSnapshot,
  t: Translator = tGlobal,
): ComposerSlashOptionEmptyState | undefined {
  if (!command) {
    return undefined;
  }

  if (command.kind === "model" && buildModelOptions(runtime).length === 0) {
    return {
      title: t("slash.modelEmptyTitle"),
      description: t("slash.modelEmptyDesc"),
    };
  }

  return undefined;
}

function matchesCommand(command: ComposerSlashCommand, normalizedQuery: string): boolean {
  if (!normalizedQuery.startsWith("/")) {
    return false;
  }

  if (normalizedQuery === "/") {
    return true;
  }

  const queryWithoutSlash = normalizedQuery.replace(/^\/+/, "").trim();
  const rawSearchTerms = [command.command.toLowerCase()];
  const aliasSearchTerms = buildSlashSearchAliases(command);
  if (rawSearchTerms.some((value) => value.includes(normalizedQuery))) {
    return true;
  }

  if (!queryWithoutSlash) {
    return false;
  }

  return aliasSearchTerms.some((value) => value.includes(queryWithoutSlash));
}

function buildSlashSearchAliases(command: ComposerSlashCommand): readonly string[] {
  const aliases = new Set<string>([
    command.command.replace(/^\/+/, "").toLowerCase(),
    command.title.toLowerCase(),
    command.sourceLabel?.toLowerCase() ?? "",
    command.compatibility?.status === "terminal-only" ? "terminal-only" : "",
  ]);

  if (command.runtimeCommand) {
    aliases.add(command.runtimeCommand.name.toLowerCase());
    aliases.add(command.runtimeCommand.name.replace(/^skill:/, "").toLowerCase());
  }

  return [...aliases].filter(Boolean);
}

function describeProvider(provider: RuntimeProviderRecord): string {
  if (provider.authSource === "oauth") {
    return "OAuth connected";
  }
  if (provider.authSource === "auth_file") {
    return "Saved API key";
  }
  if (provider.authSource === "env") {
    return "Configured via environment";
  }
  if (provider.authSource === "external") {
    return "Configured externally";
  }
  if (provider.oauthSupported) {
    return "OAuth available";
  }
  if (provider.apiKeySetupSupported) {
    return "Needs API key";
  }
  return "Available";
}

function compareProviders(left: RuntimeProviderRecord, right: RuntimeProviderRecord): number {
  const leftRank = providerRank(left);
  const rightRank = providerRank(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.name.localeCompare(right.name);
}

function providerRank(provider: RuntimeProviderRecord): number {
  if (provider.hasAuth) {
    return 0;
  }
  if (provider.id === "openai-codex" || provider.id === "anthropic") {
    return 1;
  }
  if (provider.oauthSupported) {
    return 2;
  }
  return 3;
}

function providerRankForId(
  providers: readonly RuntimeProviderRecord[],
  providerId: string,
): number {
  const provider = providers.find((entry) => entry.id === providerId);
  return provider ? providerRank(provider) : 99;
}

function summarizeSkillDescription(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return "Reusable workflow";
  }

  const firstSentence = trimmed.match(/^[^.!?]+[.!?]?/)?.[0]?.trim() ?? trimmed;
  return firstSentence.length > 96 ? `${firstSentence.slice(0, 93).trimEnd()}...` : firstSentence;
}

function formatRuntimeCommandTitle(command: RuntimeCommandRecord): string {
  if (command.source === "skill" && command.name.startsWith("skill:")) {
    return titleCase(command.name.slice("skill:".length));
  }
  return titleCase(command.name.replace(/[:_-]+/g, " "));
}

function formatRuntimeCommandDescription(command: RuntimeCommandRecord): string {
  if (command.description?.trim()) {
    return command.description.trim();
  }
  if (command.source === "prompt") {
    return "Prompt template";
  }
  if (command.source === "skill") {
    return "Skill command";
  }
  return "Extension command";
}

function formatRuntimeSourceLabel(command: RuntimeCommandRecord): string {
  if (command.source === "skill") {
    return "Skill";
  }
  if (command.source === "prompt") {
    return "Prompt";
  }
  return command.sourceInfo.source.replace(/^extension:/, "");
}

export function formatSessionConfigStatus(config?: SessionConfig): string {
  const parts = [
    config?.provider && config?.modelId ? `Model ${config.provider}:${config.modelId}` : undefined,
    config?.thinkingLevel ? `Thinking ${config.thinkingLevel}` : undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : "No session overrides set";
}

export function parseComposerCommand(value: string): ParsedComposerCommand | undefined {
  const trimmed = value.trim();
  if (trimmed === "/tree") {
    return { type: "tree" };
  }
  if (trimmed === "/status") {
    return { type: "status" };
  }
  if (trimmed === "/session") {
    return { type: "session" };
  }
  if (trimmed === "/reload") {
    return { type: "reload" };
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  if (command === "/compact") {
    return { type: "compact", customInstructions: rest.join(" ").trim() || undefined };
  }
  if (command === "/name") {
    const title = rest.join(" ").trim();
    return title ? { type: "name", title } : undefined;
  }
  if (command === "/thinking") {
    const thinkingLevel = rest[0]?.trim();
    if (!thinkingLevel) {
      return undefined;
    }
    return { type: "thinking", thinkingLevel };
  }

  if (command === "/model") {
    if (rest.length >= 2) {
      return {
        type: "model",
        provider: rest[0] ?? "",
        modelId: rest.slice(1).join(" "),
      };
    }

    const combined = rest[0];
    if (combined?.includes(":")) {
      const [provider, ...modelParts] = combined.split(":");
      const modelId = modelParts.join(":");
      if (provider && modelId) {
        return { type: "model", provider, modelId };
      }
    }
  }

  return undefined;
}

export function incompleteComposerCommandMessage(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const [command] = trimmed.split(/\s+/);
  const key = INCOMPLETE_COMMAND_MESSAGES[command as keyof typeof INCOMPLETE_COMMAND_MESSAGES];
  // Called from the main process, which has no React context — tGlobal tracks
  // the locale the store last set.
  return key ? tGlobal(key) : undefined;
}

export function isExactSlashCommand(query: string, command: ComposerSlashCommand): boolean {
  return query.trim().toLowerCase() === command.command.toLowerCase();
}

export function parseTreeComposerCommand(
  value: string,
): { readonly type: "tree" } | { readonly type: "error"; readonly message: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  if (command !== "/tree") {
    return undefined;
  }

  if (rest.length > 0) {
    return {
      type: "error",
      message: "/tree does not take arguments.",
    };
  }

  return { type: "tree" };
}
