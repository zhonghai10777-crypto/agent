import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type CompatModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export function findModel(runtime: ModelRuntime, provider: string, modelId: string): CompatModel | undefined {
  return runtime.getModel(provider, modelId);
}

export function listModels(runtime: ModelRuntime): readonly CompatModel[] {
  return runtime.getModels();
}

export function listAvailableModels(runtime: ModelRuntime): readonly CompatModel[] {
  return runtime.getAvailableSnapshot();
}

export function modelSupportsImages(model: CompatModel): boolean {
  return model.input.includes("image");
}
