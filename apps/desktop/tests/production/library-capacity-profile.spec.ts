import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { totalmem, release } from "node:os";
import { expect, test } from "@playwright/test";
import { createNamedThread, launchDesktop, makeUserDataDir, makeWorkspace, runLibraryRuntimeTool } from "../helpers/electron-app";

for (const [size, chars] of [["small", 8_000], ["medium", 800_000], ["near-limit", 7_900_000]] as const) {
  test(`synthetic library capacity measurement: ${size}`, async ({}, info) => {
    test.skip(process.env.PI_APP_TEST_LIBRARY_PROFILE !== "1", "Explicit synthetic capacity measurement only.");
    test.setTimeout(120_000);
    const root = info.outputPath("synthetic-library");
    await mkdir(root, { recursive: true });
    let fileBytes = 0;
    const count = 8;
    const tail = `PROFILE_TAIL_${size}_7`;
    for (let i = 0; i < count; i++) {
      const marker = `PROFILE_TAIL_${size}_${i}`;
      const text = "合成资料 Synthetic 0123456789\n".repeat(Math.ceil(chars / count / 10)).slice(0, chars / count - marker.length) + marker;
      fileBytes += Buffer.byteLength(text);
      await writeFile(join(root, `${i}.txt`), text);
    }
    const userData = await makeUserDataDir("library-profile-");
    const workspace = await makeWorkspace("library-profile");
    const launchedAt = performance.now();
    const harness = await launchDesktop(userData, { initialWorkspaces: [workspace], scrubProviderEnv: true, testMode: "background" });
    try {
      const page = await harness.firstWindow();
      await createNamedThread(page, "Synthetic capacity measurement");
      const launchToUsableMs = performance.now() - launchedAt;
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Local library", exact: true }).click();
      await harness.electronApp.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
      await harness.electronApp.evaluate(({ app }) => {
        const processes = app.getAppMetrics().map(({ type, memory }) => ({ type, workingSetKiB: memory.workingSetSize }));
        const state = (globalThis as any).__libraryProfile = { baseline: process.memoryUsage(), peakRss: 0, peakHeap: 0, samples: 0, maxLoopDelayMs: 0, last: performance.now(),
          baselineProcesses: processes, peakWorkingSetKiB: processes.reduce((sum, process) => sum + process.workingSetKiB, 0) };
        state.processTimer = setInterval(() => {
          state.peakWorkingSetKiB = Math.max(state.peakWorkingSetKiB, app.getAppMetrics().reduce((sum, process) => sum + process.memory.workingSetSize, 0));
        }, 100);
        state.timer = setInterval(() => {
          const now = performance.now(), memory = process.memoryUsage();
          state.peakRss = Math.max(state.peakRss, memory.rss);
          state.peakHeap = Math.max(state.peakHeap, memory.heapUsed);
          state.maxLoopDelayMs = Math.max(state.maxLoopDelayMs, now - state.last - 20);
          state.last = now; state.samples++;
        }, 20);
      });
      await page.evaluate(() => {
        const state = (window as any).__libraryProfile = { last: performance.now(), maxLoopDelayMs: 0, samples: 0 };
        state.timer = setInterval(() => { const now = performance.now(); state.maxLoopDelayMs = Math.max(state.maxLoopDelayMs, now - state.last - 20); state.last = now; state.samples++; }, 20);
      });
      const began = performance.now();
      await page.getByRole("button", { name: "Add folder", exact: true }).click();
      await expect(page.locator(".library-list")).toContainText(root);
      const enabled = page.getByLabel("Use the local library", { exact: true });
      await enabled.click();
      await expect(enabled).toBeChecked();
      const ipcLatencyMs: number[] = [];
      await expect.poll(async () => {
        const started = performance.now();
        const status = await page.evaluate(() => window.piApp.getLibraryIndexStatus());
        ipcLatencyMs.push(performance.now() - started);
        return status;
      }, { timeout: 60_000, intervals: [50] }).toMatchObject({ state: "ready", documents: count, skipped: [] });
      const rebuildMs = performance.now() - began;
      const searchLatencyMs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        const result = await runLibraryRuntimeTool(harness, "library_search", { query: tail });
        searchLatencyMs.push(performance.now() - started);
        expect(result.content[0]?.text).toContain(tail);
      }
      let overflowInputChars = 0, overflowInputBytes = 0;
      if (size === "near-limit") {
        const overflow = "synthetic capacity overflow ".repeat(20_000);
        overflowInputChars = overflow.length;
        overflowInputBytes = Buffer.byteLength(overflow);
        await writeFile(join(root, "z-over-capacity.txt"), overflow);
        await page.getByRole("button", { name: "Prepare again", exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.piApp.getLibraryIndexStatus())).toMatchObject({ state: "ready", documents: count, skipped: [expect.objectContaining({ reasonCode: "capacity" })] });
      }
      const main = await harness.electronApp.evaluate(({ app }) => {
        const state = (globalThis as any).__libraryProfile;
        clearInterval(state.timer); clearInterval(state.processTimer);
        const final = process.memoryUsage();
        const finalProcesses = app.getAppMetrics().map(({ type, memory }) => ({ type, workingSetKiB: memory.workingSetSize }));
        const { timer, processTimer, last, ...measurements } = state;
        return { ...measurements, peakRss: Math.max(state.peakRss, final.rss), peakHeap: Math.max(state.peakHeap, final.heapUsed),
          peakWorkingSetKiB: Math.max(state.peakWorkingSetKiB, finalProcesses.reduce((sum, process) => sum + process.workingSetKiB, 0)),
          final, finalProcesses, electron: process.versions.electron, node: process.versions.node };
      });
      const renderer = await page.evaluate(() => {
        const state = (window as any).__libraryProfile;
        clearInterval(state.timer);
        return { maxLoopDelayMs: state.maxLoopDelayMs, samples: state.samples };
      });
      const status = await page.evaluate(() => window.piApp.getLibraryIndexStatus());
      // Count the actual persisted searchable text, independently of fixture input.
      const saved = JSON.parse(await readFile(join(userData, "library-index", "index.json"), "utf8")) as {
        documents: { parts: string[]; complete: boolean }[];
      };
      expect(saved.documents).toHaveLength(count);
      expect(saved.documents.every((document) => document.complete)).toBe(true);
      const extractedChars = saved.documents.reduce((sum, document) => sum + document.parts.reduce((count, part) => count + part.length, 0), 0);
      const report = { size, documentCount: count, inputBytes: fileBytes, inputChars: chars, indexedParts: status.parts,
        extractedChars, extractedCharsDefinition: "UTF-16 code units in the complete persisted searchable parts", overflowInputChars, overflowInputBytes,
        platform: process.platform, architecture: process.arch, osRelease: release(), hostMemoryBytes: totalmem(),
        launchToUsableMs, rebuildMs, ipcLatencyMs, searchLatencyMs, main, renderer,
        note: "Synthetic data on the recorded host, not a Windows 4 GB or 8 GB hardware acceptance result. Main RSS includes Worker threads. Summed Electron process working sets may double-count shared pages and are sampled every 100 ms. Near-limit peak includes one capacity-rejected extra document." };
      await writeFile(info.outputPath("measurement.json"), JSON.stringify(report, null, 2));
      await page.screenshot({ path: info.outputPath("library-profile.png") });
      console.log(JSON.stringify(report));
    } finally { await harness.close(); }
  });
}
