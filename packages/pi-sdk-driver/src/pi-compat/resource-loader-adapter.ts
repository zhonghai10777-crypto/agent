import {
  DefaultResourceLoader,
  createExtensionRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

type CompatResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export function createCompatResourceLoader(options: CompatResourceLoaderOptions): ResourceLoader {
  return new DefaultResourceLoader(options);
}

export function createStaticResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    getSystemPromptSource: () => undefined,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
