/**
 * Regenerates the binary document fixtures used by the document-extraction
 * tests. The outputs are committed, so this only needs to run when a fixture
 * needs to change — CI never invokes it.
 *
 *   node apps/desktop/tests/fixtures/generate-documents.mjs
 *
 * PDFs come from headless Chromium (already present for the Playwright suite)
 * because it embeds a real CJK text layer, which is exactly what the extractor
 * has to pull back out. The "scanned" fixture is deliberately image-only so the
 * no-text-layer path has something honest to fail on.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "documents");

const CLAUSE = "第 3.2 条：额定负荷下锅炉效率不低于 92%。";
const SECOND_PAGE = "第 4.1 条：机组启动前应完成全部保护投入试验。";

/**
 * Playwright's bundled browser revision and whatever is actually in the shared
 * ms-playwright cache drift apart routinely, and this generator is not worth a
 * 150MB download. Prefer an already-installed Chromium and only fall back to
 * the bundled resolution when none is found.
 */
async function findChromium() {
  const { readdir } = await import("node:fs/promises");
  const cache = path.join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
  const candidates = [];
  try {
    for (const entry of await readdir(cache)) {
      if (!entry.startsWith("chromium-")) continue;
      candidates.push(
        path.join(
          cache,
          entry,
          "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
      );
    }
  } catch {
    return undefined;
  }
  const { access } = await import("node:fs/promises");
  for (const candidate of candidates.sort().reverse()) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* try the next revision */
    }
  }
  return undefined;
}

async function generatePdfs() {
  const { chromium } = await import("playwright");
  const executablePath = await findChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage();

    await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
      <style>body{font-family:"PingFang SC","Songti SC",sans-serif;font-size:16px;padding:40px}
      .page-break{page-break-before:always}</style></head><body>
      <h1>火力发电机组运行规程</h1>
      <p>${CLAUSE}</p>
      <p>本规程适用于 300MW 及以上等级机组。</p>
      <div class="page-break"><h2>第四章 启动与停运</h2><p>${SECOND_PAGE}</p></div>
      </body></html>`);
    await page.pdf({ path: path.join(outDir, "standard-zh.pdf"), format: "A4" });

    // Image-only: no text layer at all, so extraction must report "scanned"
    // rather than quietly returning an empty string.
    const pixel =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAYAAACqNX6+AAAAPUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4M0AVAAAAV8AiJcAAAAASUVORK5CYII=";
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"></head>` +
        `<body style="margin:0"><img src="${pixel}" style="width:600px;height:300px"></body></html>`,
    );
    await page.pdf({ path: path.join(outDir, "scanned-zh.pdf"), format: "A4" });
  } finally {
    await browser.close();
  }
}

async function generateDocx() {
  // textutil is the macOS-only generator for this committed fixture; the test
  // suite reads the committed .docx and never shells out to it.
  const htmlPath = path.join(outDir, ".docx-source.html");
  await writeFile(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8"></head><body>
     <h1>设备缺陷分析报告</h1><p>${CLAUSE}</p>
     <table border="1"><tr><td>机组号</td><td>缺陷等级</td></tr><tr><td>2 号机</td><td>一般</td></tr></table>
     </body></html>`,
    "utf8",
  );
  await execFileAsync("textutil", [
    "-convert", "docx",
    "-output", path.join(outDir, "standard-zh.docx"),
    htmlPath,
  ]);
  await rm(htmlPath, { force: true });
}

async function generateXlsx() {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();

  const runSheet = workbook.addWorksheet("运行参数");
  runSheet.addRow(["参数", "设计值", "实测值"]);
  runSheet.addRow(["主蒸汽压力(MPa)", 16.7, 16.5]);
  runSheet.addRow(["锅炉效率(%)", 92, 92.4]);

  const defectSheet = workbook.addWorksheet("缺陷台账");
  defectSheet.addRow(["编号", "描述"]);
  defectSheet.addRow(["D-001", "给水泵密封泄漏"]);

  await workbook.xlsx.writeFile(path.join(outDir, "standard-zh.xlsx"));
}

async function generateTextFiles() {
  const csv = "机组,负荷,效率\n1 号机,300MW,92.4%\n2 号机,600MW,93.1%\n";
  await writeFile(path.join(outDir, "utf8-sample.csv"), csv, "utf8");

  // GBK is what a large share of domestic technical exports actually ship as,
  // and is the encoding that silently turns into mojibake today. Node can
  // decode GBK via TextDecoder but cannot encode it, so shell out — and read
  // the result from stdout, since the BSD iconv on macOS has no -o flag.
  const utf8Path = path.join(outDir, ".gbk-source.txt");
  await writeFile(utf8Path, csv, "utf8");
  const { stdout } = await execFileAsync("iconv", ["-f", "UTF-8", "-t", "GBK", utf8Path], {
    encoding: "buffer",
  });
  await writeFile(path.join(outDir, "gbk-sample.csv"), stdout);
  await rm(utf8Path, { force: true });
}

await mkdir(outDir, { recursive: true });
await generatePdfs();
await generateDocx();
await generateXlsx();
await generateTextFiles();
console.log(`fixtures written to ${outDir}`);
