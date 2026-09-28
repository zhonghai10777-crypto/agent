import test from "node:test";
import assert from "node:assert/strict";
import { makeSupervisedSession, waitUntil } from "./supervised-session-fixture.mts";

test("streaming text is delivered per delta without persisting the catalog or re-publishing the snapshot per token", async () => {
  const deltas = Array.from({ length: 200 }, (_, index) => `w${index} `);
  const fixture = await makeSupervisedSession("text", [{ kind: "text", deltas }]);
  try {
    const upsertsBefore = fixture.upserts();
    const eventsBefore = fixture.events.length;
    await fixture.supervisor.sendUserMessage(fixture.ref, { text: "go" });
    await waitUntil(() => fixture.events.some((event) => event.type === "runCompleted"));

    const runEvents = fixture.events.slice(eventsBefore);
    const streamed = runEvents.filter((event) => event.type === "assistantDelta").map((event) => event.text).join("");
    assert.equal(streamed, deltas.join(""), "every delta still reaches listeners, in order");

    // Before the fix both of these scaled with the token count (~1 per delta:
    // a full catalogs.json read/backup/fsync/rename and a full snapshot emit).
    // They are now bounded by run boundaries, not by the length of the reply.
    const upserts = fixture.upserts() - upsertsBefore;
    const sessionUpdates = runEvents.filter((event) => event.type === "sessionUpdated").length;
    assert.ok(upserts <= 15, `catalog upserts during the run should not scale with tokens (got ${upserts})`);
    assert.ok(sessionUpdates <= 15, `sessionUpdated events should not scale with tokens (got ${sessionUpdates})`);

    // The final preview still lands in the catalog once the message completes.
    const entry = await fixture.catalog.sessions.getSession(fixture.ref);
    assert.ok(entry?.previewSnippet?.startsWith("w0 w1 w2"), `preview persisted at message end (got ${entry?.previewSnippet})`);
    assert.equal(entry?.status, "idle");
  } finally {
    await fixture.cleanup();
  }
});
