import { join, resolve } from "node:path";
import {
  ModelRegistry,
  ModelRuntime,
  getAgentDir,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent";
import { CustomProviderStore } from "./custom-provider-store.js";
import type { RuntimeSupervisorOptions } from "./runtime-supervisor.js";

export interface RuntimeDependencies {
  readonly agentDir: string;
  readonly modelRuntime: Promise<ModelRuntime>;
  readonly modelRegistry: Promise<ModelRegistry>;
  readonly credentialStore?: RuntimeCredentialStore;
  readonly customProviderStore: CustomProviderStore;
}

export type RuntimeCredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
export type RuntimeCredential = Awaited<ReturnType<RuntimeCredentialStore["read"]>>;
export type RuntimeCredentialInfo = Awaited<ReturnType<RuntimeCredentialStore["list"]>>[number];

export function createRuntimeDependencies(options: RuntimeSupervisorOptions = {}): RuntimeDependencies {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const modelsJsonPath = join(agentDir, "models.json");
  const modelRuntime = options.modelRuntime
    ? Promise.resolve(options.modelRuntime)
    : ModelRuntime.create({
        ...(options.credentialStore ? { credentials: options.credentialStore } : { authPath: join(agentDir, "auth.json") }),
        modelsPath: modelsJsonPath,
      });
  const modelRegistry = options.modelRegistry
    ? Promise.resolve(options.modelRegistry)
    : modelRuntime.then((runtime) => new ModelRegistry(runtime));
  const customProviderStore = options.customProviderStore ?? new CustomProviderStore(modelsJsonPath);
  return {
    agentDir,
    modelRuntime,
    modelRegistry,
    ...(options.credentialStore ? { credentialStore: options.credentialStore } : {}),
    customProviderStore,
  };
}
