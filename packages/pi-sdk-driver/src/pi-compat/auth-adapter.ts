import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type CompatModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
type AuthResult = Awaited<ReturnType<ModelRuntime["getAuth"]>>;
type AuthInteraction = Parameters<ModelRuntime["login"]>[2];
type CredentialInfo = Awaited<ReturnType<ModelRuntime["listCredentials"]>>[number];

export function resolveModelAuth(runtime: ModelRuntime, model: CompatModel): Promise<AuthResult> {
  return runtime.getAuth(model);
}

export function resolveProviderAuth(runtime: ModelRuntime, providerId: string): Promise<AuthResult> {
  return runtime.getAuth(providerId);
}

export function setRuntimeApiKey(runtime: ModelRuntime, providerId: string, apiKey: string): Promise<void> {
  return runtime.setRuntimeApiKey(providerId, apiKey);
}

export function removeRuntimeApiKey(runtime: ModelRuntime, providerId: string): Promise<void> {
  return runtime.removeRuntimeApiKey(providerId);
}

export function loginProvider(
  runtime: ModelRuntime,
  providerId: string,
  type: "api_key" | "oauth",
  interaction: AuthInteraction,
): ReturnType<ModelRuntime["login"]> {
  return runtime.login(providerId, type, interaction);
}

export function logoutProvider(runtime: ModelRuntime, providerId: string): Promise<void> {
  return runtime.logout(providerId);
}

export function listCredentialInfo(runtime: ModelRuntime): Promise<readonly CredentialInfo[]> {
  return runtime.listCredentials();
}

/**
 * Persist an API key for a provider.
 *
 * `setRuntimeApiKey` must not be used for this: the SDK documents
 * `RuntimeCredentials` as an "async credential store overlay for
 * non-persistent runtime API keys", so a key stored through it is readable for
 * the rest of the session and gone on restart — after which the provider falls
 * back to whatever models.json holds, which for a managed custom endpoint is
 * the literal placeholder. `login` with the api_key type writes through the
 * credential store instead.
 */
export function persistApiKey(runtime: ModelRuntime, providerId: string, apiKey: string): Promise<unknown> {
  return runtime.login(providerId, "api_key", {
    prompt: async () => apiKey,
    notify: () => {},
  });
}

/** Remove a persisted credential; `removeRuntimeApiKey` only drops the overlay. */
export async function removePersistedApiKey(runtime: ModelRuntime, providerId: string): Promise<void> {
  try {
    await runtime.logout(providerId);
  } catch {
    // No stored credential to remove — deleting an endpoint that never had a
    // key must still succeed.
  }
}
