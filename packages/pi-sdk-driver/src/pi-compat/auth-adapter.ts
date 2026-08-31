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
