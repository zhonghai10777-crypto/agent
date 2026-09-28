import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;
const pathsProject = path.resolve(projectRoot, "tsconfig.paths.json");
const devPort = Number(process.env.PI_APP_DEV_PORT ?? "5173");
/**
 * Content-Security-Policy for the packaged renderer. It loads its bundle from
 * its own files and renders images from data: URLs; xterm injects <style>
 * elements, hence 'unsafe-inline' for styles only. Scripts stay limited to the
 * bundle, so injected markup can never run code. Applied to builds only: the
 * dev server needs an inline React-refresh script and a websocket.
 */
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function rendererContentSecurityPolicy() {
  return {
    name: "pi-renderer-content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: RENDERER_CSP }, injectTo: "head-prepend" },
    ],
  };
}

export default defineConfig(({ command }) => {
  const cleanOutputs = command === "build";

  return {
    main: {
      plugins: [tsconfigPaths({ projects: [pathsProject] })],
      define: {
        // Only the public repository identifier is embedded; runtime tokens never are.
        "process.env.PI_APP_BUILD_UPDATE_REPOSITORY": JSON.stringify(process.env.PI_APP_UPDATE_REPOSITORY ?? ""),
      },
      build: {
        outDir: "out/main",
        emptyOutDir: cleanOutputs,
        rollupOptions: {
          input: {
            main: path.resolve(projectRoot, "electron/main.ts"),
            "document-worker": path.resolve(projectRoot, "electron/document-worker.ts"),
            "vision-image-worker": path.resolve(projectRoot, "electron/vision-image-worker.ts"),
          },
          output: {
            // `@earendil-works/pi-coding-agent` ships ESM-only exports (no
            // CommonJS require condition), so the main bundle must be ESM.
            format: "es",
            entryFileNames: "[name].mjs",
          },
        },
      },
    },
    preload: {
      plugins: [tsconfigPaths({ projects: [pathsProject] })],
      build: {
        outDir: "out/preload",
        emptyOutDir: cleanOutputs,
        rollupOptions: {
          input: {
            preload: path.resolve(projectRoot, "electron/preload.ts"),
          },
          output: {
            // Electron sandboxed preload scripts must be CommonJS, even when
            // the main bundle is ESM.
            format: "cjs",
            entryFileNames: "[name].cjs",
          },
        },
      },
    },
    renderer: {
      root: projectRoot,
      base: "./",
      plugins: [react(), tsconfigPaths({ projects: [pathsProject] }), rendererContentSecurityPolicy()],
      server: {
        port: devPort,
        strictPort: true,
      },
      build: {
        outDir: "out/renderer",
        emptyOutDir: true,
        rollupOptions: {
          input: path.resolve(projectRoot, "index.html"),
        },
      },
    },
  };
});
