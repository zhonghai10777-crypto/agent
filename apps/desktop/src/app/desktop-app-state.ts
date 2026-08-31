import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AssistantDeltaEvent, DesktopAppState, SelectedTranscriptRecord } from "../desktop-state";

export function useDesktopAppState() {
  const [snapshot, setSnapshot] = useState<DesktopAppState | null>(null);
  const [selectedTranscript, setSelectedTranscript] = useState<SelectedTranscriptRecord | null>(null);
  const assistantDeltaSequencesRef = useRef(new Map<string, { readonly messageId: string; readonly sequence: number }>());

  useEffect(() => {
    let active = true;
    let receivedPushedTranscript = false;
    const api = window.piApp;
    if (!api) {
      return undefined;
    }

    // The initial getState() can resolve after an early pushed state-changed event; never let a
    // snapshot with a lower revision overwrite a newer one already applied to state.
    const applyState = (incoming: DesktopAppState) => {
      applySnapshotIfNewer(setSnapshot, incoming);
    };

    void Promise.all([api.getState(), api.getSelectedTranscript()]).then(([state, transcript]) => {
      if (!active) {
        return;
      }
      applyState(state);
      // SelectedTranscriptRecord carries no revision marker, so the stale initial transcript is
      // only applied when no pushed transcript has arrived yet.
      if (!receivedPushedTranscript) {
        setSelectedTranscript(transcript);
      }
    });

    const unsubscribeState = api.onStateChanged((state) => {
      if (active) {
        applyState(state);
      }
    });
    const unsubscribeTranscript = api.onSelectedTranscriptChanged((payload) => {
      if (active) {
        receivedPushedTranscript = true;
        setSelectedTranscript(payload);
      }
    });
    const unsubscribeAssistantDelta = api.onAssistantDelta((event) => {
      if (!active) {
        return;
      }
      receivedPushedTranscript = true;
      const key = `${event.workspaceId}\0${event.sessionId}`;
      const previous = assistantDeltaSequencesRef.current.get(key);
      const previousSequence = previous?.messageId === event.messageId ? previous.sequence : 0;
      if (event.sequence <= previousSequence) {
        return;
      }
      assistantDeltaSequencesRef.current.set(key, { messageId: event.messageId, sequence: event.sequence });
      setSelectedTranscript((current) => applyAssistantDelta(current, event));
    });

    return () => {
      active = false;
      unsubscribeState();
      unsubscribeTranscript();
      unsubscribeAssistantDelta();
    };
  }, []);

  return [snapshot, setSnapshot, selectedTranscript] as const;
}

export function applyAssistantDelta(
  current: SelectedTranscriptRecord | null,
  event: AssistantDeltaEvent,
): SelectedTranscriptRecord | null {
  if (!current || current.workspaceId !== event.workspaceId || current.sessionId !== event.sessionId) {
    return current;
  }
  const messageIndex = current.transcript.findIndex((item) => item.id === event.messageId);
  if (messageIndex < 0) {
    return {
      ...current,
      transcript: [
        ...current.transcript,
        {
          kind: "message",
          id: event.messageId,
          role: "assistant",
          text: event.delta,
          createdAt: event.createdAt,
        },
      ],
    };
  }
  const message = current.transcript[messageIndex];
  if (message?.kind !== "message" || message.role !== "assistant") {
    return current;
  }
  const transcript = [...current.transcript];
  transcript[messageIndex] = { ...message, text: `${message.text}${event.delta}` };
  return { ...current, transcript };
}

/**
 * Never let a state snapshot with a lower revision overwrite a newer one. IPC
 * responses race the pushed state-changed events: a response is built when the
 * handler returns, but concurrent session events can bump the state (and get
 * pushed) before the response crosses the IPC boundary. Applying the stale
 * response unguarded would silently roll the UI back — e.g. a /name rename
 * right after an aborted run lost its title this way.
 */
export function applySnapshotIfNewer(
  setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
  incoming: DesktopAppState,
): void {
  setSnapshot((current) => (current && incoming.revision < current.revision ? current : incoming));
}

export function updateSnapshot(
  api: NonNullable<typeof window.piApp>,
  setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
  action: () => Promise<DesktopAppState>,
) {
  return action().then((state) => {
    applySnapshotIfNewer(setSnapshot, state);
    return state;
  });
}
