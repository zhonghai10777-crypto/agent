import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SessionAttachment } from "@pi-gui/session-driver";

export class ImageInputDisabledError extends Error {
  readonly code = "IMAGE_INPUT_DISABLED";

  constructor(readonly providerId: string, readonly modelId: string) {
    super(`Image input is not enabled for ${providerId}/${modelId}. Enable it for a vision-capable custom model or choose a model that accepts images.`);
    this.name = "ImageInputDisabledError";
  }
}

export function isImageInputDisabledError(error: unknown): error is ImageInputDisabledError {
  return error instanceof ImageInputDisabledError || (
    typeof error === "object" && error !== null &&
    "code" in error && error.code === "IMAGE_INPUT_DISABLED" &&
    "providerId" in error && typeof error.providerId === "string" &&
    "modelId" in error && typeof error.modelId === "string"
  );
}

export function prepareSessionImageInput(
  session: AgentSession,
  attachments?: readonly SessionAttachment[],
  canRouteImages?: (model: NonNullable<AgentSession["model"]>) => boolean,
): void {
  let model = session.model;
  if (!model) return;
  const selectedInput = model.input;

  // Registry refreshes leave the session's selected model object unchanged.
  // Refresh only capabilities between runs, without switching models or adding history.
  const input = !session.isStreaming
    ? session.modelRuntime.getModel(model.provider, model.id)?.input ?? selectedInput
    : selectedInput;
  if (input.length !== selectedInput.length || input.some((value, index) => value !== selectedInput[index])) {
    model = { ...model, input: [...input] };
    session.agent.state.model = model;
  }

  // A configured assistance route owns its own policy and error handling.
  if (attachments?.some((attachment) => attachment.kind === "image") && !input.includes("image") && !canRouteImages?.(model)) {
    throw new ImageInputDisabledError(model.provider, model.id);
  }
}
