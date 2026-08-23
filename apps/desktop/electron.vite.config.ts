import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    /*
     * Bundle the two runtime dependencies rather than externalising them.
     *
     * `@karen/protocol` is a workspace package that exists only as a symlink
     * into the repo root, and `ws` is hoisted to the root as well -- neither
     * sits in apps/desktop/node_modules, which is where a packaged app would
     * look for them. Bundling means the packaged main process has no runtime
     * module resolution to get wrong, and the .deb carries no node_modules at
     * all. Both are plain JavaScript with no native addons, so there is nothing
     * that needs to stay external.
     */
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve("src/main/index.ts") } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve("src/preload/index.ts") } } },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve("src/renderer/index.html") } },
      // Everything ships in the bundle: no CDN, no remote font, nothing fetched
      // at runtime. This is a privacy requirement, not a preference.
      assetsInlineLimit: 0,
    },
  },
});
