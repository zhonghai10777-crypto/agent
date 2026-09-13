export interface CustomProviderModelInput {
  readonly id: string;
  readonly contextWindow?: number;
  readonly input?: readonly ("text" | "image")[];
}

const DEEPSEEK_IMAGE_MODELS = new Set([
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
]);

/** Documented defaults for the official endpoint; unknown models need an explicit capability. */
export function defaultCustomModelInput(baseUrl: string, modelId: string): readonly ("text" | "image")[] {
  try {
    const url = new URL(baseUrl);
    if (url.origin === "https://api.deepseek.com" && !url.username && !url.password && !url.search && !url.hash &&
        ["", "/v1"].includes(url.pathname.replace(/\/+$/, "")) && DEEPSEEK_IMAGE_MODELS.has(modelId)) {
      return ["text", "image"];
    }
  } catch {
    // URL validation belongs to the endpoint form and store.
  }
  return ["text"];
}

export function isCustomModelInput(value: unknown): value is readonly ("text" | "image")[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => item === "text" || item === "image");
}

export interface CustomProviderInput {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models?: readonly CustomProviderModelInput[];
}

export interface CustomProviderEntry {
  readonly providerId: string;
  readonly baseUrl: string;
  /**
   * A plaintext key left in models.json by a pre-encryption build. Absent for
   * the placeholder. Callers must treat this as the only copy of that key.
   */
  readonly apiKey?: string;
  readonly models: readonly CustomProviderModelInput[];
}

/**
 * What the UI is told about an endpoint. Deliberately carries no key material:
 * reporting a mask instead let the mask be echoed back on save and stored as the
 * literal credential.
 */
export interface CustomProviderSummary {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly hasApiKey: boolean;
  readonly models: readonly CustomProviderModelInput[];
}

export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const OPENAI_COMPLETIONS_API = "openai-completions";

export const CUSTOM_PROVIDER_PLACEHOLDER_API_KEY = "unused";
export const PI_GUI_CUSTOM_PROVIDER_MARKER = "piGuiCustomEndpoint";
export const BUILT_IN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "amazon-bedrock",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "zai",
]);

export function isValidHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.host.length > 0;
  } catch {
    return false;
  }
}
