import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/*
 * The main-process build deliberately does NOT bundle its dependencies.
 *
 * In v1 bundling them wedged the app in a way that took two sessions to find:
 * the process started, sockets listened, and nothing was ever accepted -- 0%
 * CPU, no exception, no output. externalizeDepsPlugin is load-bearing.
 */
/**
 * Let the dev server's own inline script run, and nothing else.
 *
 * index.html carries a strict CSP in a <meta> tag, which is the policy that
 * protects the packaged app -- `onHeadersReceived` does not reach file://
 * responses, so the meta tag is not belt-and-braces, it is the belt.
 *
 * It also forbids inline script, and in development that is fatal:
 * @vitejs/plugin-react injects an inline preamble to install React Refresh,
 * the policy blocks it, and the app dies with "can't detect preamble" and an
 * empty <div id="root">. The window opens, renders nothing, and the terminal
 * says nothing about why.
 *
 * So the meta tag stays exactly as written for the build that ships, and this
 * rewrites it for the dev server only. `apply: "serve"` is what guarantees the
 * production HTML is never touched.
 */
function devCsp(): Plugin {
  return {
    name: "karen:dev-csp",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"[^>]*content=")([^"]*)(")/i,
        (_m, head: string, policy: string, tail: string) => {
          const relaxed = policy
            .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            .replace("connect-src 'self'", "connect-src 'self' ws: http://localhost:*");
          return `${head}${relaxed}${tail}`;
        },
      );
    },
  };
}

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
    plugins: [react(), devCsp()],
    build: {
      rollupOptions: { input: { index: resolve("src/renderer/index.html") } },
    },
  },
});
