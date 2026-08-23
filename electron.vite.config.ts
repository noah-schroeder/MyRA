import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/*
 * The main-process build deliberately does NOT bundle its dependencies.
 *
 * In v1 bundling them wedged the app in a way that took two sessions to find:
 * the process started, sockets listened, and nothing was ever accepted -- 0%
 * CPU, no exception, no output. externalizeDepsPlugin is load-bearing.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve("src/main/index.ts") } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") },
        /*
         * CommonJS, explicitly, with a .cjs extension.
         *
         * A SANDBOXED preload cannot be an ES module -- Electron loads it in a
         * context without a module loader, and an ESM preload fails with
         * "Cannot use import statement outside a module". The failure is
         * quiet: the window still opens, and every window.karen call is
         * undefined, so the app looks broken rather than misconfigured.
         *
         * The extension matters too, because package.json says
         * "type": "module", which would make a .js file ESM again.
         */
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve("src/renderer/index.html") } },
    },
  },
});
