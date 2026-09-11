/**
 * The API server, exposed to the window.
 *
 * Thin pass-throughs, in the shape `installRuntimeIpc` established: every
 * handler answers `{ ok }` rather than throwing across the bridge, so a port
 * conflict shows up as a sentence on the page rather than an unhandled
 * rejection in the main process.
 *
 * One thing never crosses this bridge: a key's hash. `ApiManager.state` blanks
 * it, and the plaintext secret is returned exactly once, by `api-key-create`.
 */

import { ipcMain } from "electron";

import type { ApiManager } from "./manager.ts";

export function installApiIpc(
  api: ApiManager,
  send: (channel: string, payload?: unknown) => void,
): void {
  api.onChange(() => send("myra:api", api.state));
  api.onLog(() => send("myra:api-log", api.log.entries));

  ipcMain.handle("myra:api-state", () => api.state);

  ipcMain.handle("myra:api-config", async (_e, patch: Record<string, unknown>) => {
    try {
      return { ok: true, state: await api.update(patch) };
    } catch (err) {
      return { ok: false, error: (err as Error).message, state: api.state };
    }
  });

  ipcMain.handle("myra:api-start", async () => {
    try {
      const state = await api.start();
      /* A refusal is reported through the status, not thrown: "port 1234 is
         taken" is information for the page, not an error condition. */
      return { ok: !state.status.error, error: state.status.error, state };
    } catch (err) {
      return { ok: false, error: (err as Error).message, state: api.state };
    }
  });

  ipcMain.handle("myra:api-stop", async () => {
    try {
      return { ok: true, state: await api.stop() };
    } catch (err) {
      return { ok: false, error: (err as Error).message, state: api.state };
    }
  });

  ipcMain.handle("myra:api-key-create", async (_e, label: string) => {
    try {
      const { state, secret } = await api.createKey(String(label ?? ""));
      // The only moment this value exists outside the minting function.
      return { ok: true, state, secret };
    } catch (err) {
      return { ok: false, error: (err as Error).message, state: api.state };
    }
  });

  ipcMain.handle("myra:api-key-revoke", async (_e, id: string) => {
    try {
      return { ok: true, state: await api.revokeKey(String(id)) };
    } catch (err) {
      return { ok: false, error: (err as Error).message, state: api.state };
    }
  });

  ipcMain.handle("myra:api-requests", () => ({ ok: true, entries: api.log.entries }));

  ipcMain.handle("myra:api-cancel", (_e, id: string) => ({
    ok: api.cancel(String(id)),
  }));

  ipcMain.handle("myra:api-clear-log", () => {
    api.clearLog();
    return { ok: true, entries: api.log.entries };
  });
}
