import test from "node:test";
import assert from "node:assert/strict";
import { SessionSupervisor } from "../dist/session-supervisor.js";
import { sessionKey, shouldTailFromDisk } from "../dist/session-supervisor-utils.js";

const base = { isStreaming: false, diskMtimeMs: 2_000, baselineMtimeMs: 1_000 };

test("tails from disk when an idle session's file grew past the reconciled baseline", () => {
  // This is the external-append case: `pi --continue` bumped the JSONL mtime
  // beyond what the in-memory runtime last reconciled.
  assert.equal(shouldTailFromDisk(base), true);
});

test("never tails mid-stream — the live runtime is authoritative while generating", () => {
  assert.equal(shouldTailFromDisk({ ...base, isStreaming: true }), false);
});

test("does not tail when disk mtime is unchanged or older than the baseline", () => {
  assert.equal(shouldTailFromDisk({ ...base, diskMtimeMs: 1_000 }), false);
  assert.equal(shouldTailFromDisk({ ...base, diskMtimeMs: 500 }), false);
});

test("does not tail without a stat result (also covers a missing session file)", () => {
  assert.equal(shouldTailFromDisk({ ...base, diskMtimeMs: undefined }), false);
});

test("first serve (no baseline yet) serves memory, not disk", () => {
  // Baseline is captured at bind time against the freshly-opened file, so an
  // undefined baseline means we have nothing proving disk is ahead.
  assert.equal(shouldTailFromDisk({ ...base, baselineMtimeMs: undefined }), false);
});

test("does not advance the disk baseline when the external transcript read fails", async () => {
  const supervisor = new SessionSupervisor();
  const ref = {
    workspaceId: "workspace",
    sessionId: "session",
  } as Parameters<SessionSupervisor["getTranscript"]>[0];
  const record = {
    session: { isStreaming: false, messages: [] },
    sessionFile: "/tmp/session.jsonl",
    transcriptDiskMtimeMs: 1_000,
    updatedAt: new Date(0).toISOString(),
    closed: false,
  };
  const internals = supervisor as unknown as {
    records: Map<string, unknown>;
    statMtimeMs: (filePath: string | undefined) => Promise<number | undefined>;
    readTranscriptFromDisk: (sessionRef: typeof ref) => Promise<never>;
  };

  internals.records.set(sessionKey(ref), record);
  internals.statMtimeMs = async () => 2_000;
  internals.readTranscriptFromDisk = async () => {
    throw new Error("simulated EBUSY");
  };

  await assert.rejects(supervisor.getTranscript(ref), /simulated EBUSY/);
  assert.equal(record.transcriptDiskMtimeMs, 1_000);
});
