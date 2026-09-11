/**
 * MyRA in the system tray, so closing the window does not stop the work.
 *
 * The reason this exists: once another app is talking to MyRA over the API,
 * the window is in the way. You want the model and the gateway up and the
 * window gone -- and you want an obvious way to bring it back and an obvious
 * way to actually quit.
 *
 * ## The failure this must not have
 *
 * Hiding a window behind a tray icon that never appears leaves an application
 * running with no way to reach it. On Linux that is a real possibility rather
 * than a theoretical one: GNOME dropped the legacy tray, and whether an icon
 * shows depends on an extension being installed. So:
 *
 *   - `Tray` construction is guarded, and a failure means the window closes
 *     normally instead of hiding. Better to quit than to vanish.
 *   - The single-instance lock is the second net. Launching MyRA again --
 *     from the app menu, the terminal, anywhere -- raises the window that
 *     already exists rather than starting a second copy. That is the way back
 *     even if no icon is visible anywhere.
 *
 * The single-instance lock earns its place on its own, too: two MyRAs would
 * each start a Lemonade and fight over the API port.
 */

import { app, Menu, nativeImage, Tray, type BrowserWindow } from "electron";

import { statusAreaAvailable, statusItemRegistered } from "../core/runtime/statusArea.ts";

import { TRAY_ICON_PNG } from "./trayIcon.ts";

export interface TrayState {
  /** The model Lemonade currently holds, if any. */
  model?: string | undefined;
  /** The address the API is serving on, if it is. */
  apiUrl?: string | undefined;
}

export interface TrayDeps {
  show: () => void;
  quit: () => void;
  /** Drop the loaded model, freeing its memory without stopping MyRA. */
  eject: () => void;
  state: () => TrayState;
}

/**
 * A menu that says what is actually running.
 *
 * The tray is the only surface left once the window is hidden, so it carries
 * the two facts that answer "why is this using memory": which model is loaded,
 * and whether anything is being served. Those two are disabled rows --
 * information, not controls.
 *
 * "Eject model" is the one exception, and it earns it: the model is the
 * expensive thing, several gigabytes of VRAM held by a window that is no longer
 * on screen. Making someone reopen the window to free it would defeat the point
 * of the tray. It greys out when nothing is loaded, so the row still reads as a
 * true statement about the machine either way.
 */
function buildMenu(deps: TrayDeps): Menu {
  const { model, apiUrl } = deps.state();
  return Menu.buildFromTemplate([
    { label: "Open MyRA", click: () => deps.show() },
    { type: "separator" },
    {
      label: model ? `Model: ${model}` : "No model loaded",
      enabled: false,
    },
    {
      /* Not "Unload": the memory, not the file, is what a person is trying to
         get back, and the model comes back on the next request when
         load-on-demand is on. */
      label: "Eject model",
      enabled: model !== undefined,
      click: () => deps.eject(),
    },
    {
      label: apiUrl ? `Serving on ${apiUrl}` : "Not serving",
      enabled: false,
    },
    { type: "separator" },
    /* The only way to actually stop MyRA once the window hides, so it says
       what it does: not "Close", which is what the window button did. */
    { label: "Quit MyRA", click: () => deps.quit() },
  ]);
}

export class MyraTray {
  #tray: Tray | undefined;
  #deps: TrayDeps;

  constructor(deps: TrayDeps) {
    this.#deps = deps;
  }

  /**
   * True when an icon is actually in the status area, so hiding is safe.
   *
   * Not "a Tray object exists". That was the old test and it is the one thing
   * that cannot be trusted here: on Ubuntu GNOME with the watcher running, the
   * AppIndicator extension enabled and libayatana-appindicator3 installed,
   * `new Tray(image)` succeeds and publishes nothing -- reproduced with a bare
   * Electron script and an opaque icon, so it is neither this app's icon nor
   * its code. Believing construction meant an icon is what left MyRA running
   * with its window hidden and no way to reach it.
   *
   * Asked lazily and cached. Registration is asynchronous, so asking during
   * `start()` would race it; by the time anyone closes a window the answer has
   * long since settled, and that is the only moment it decides anything.
   */
  get available(): boolean {
    if (!this.#tray) return false;
    if (this.#registered === undefined) this.#registered = this.#verify();
    return this.#registered;
  }

  /** Re-ask on the next `available`. For a desktop that gains a status area. */
  recheck(): void {
    this.#registered = undefined;
  }

  /** undefined until asked; then whether an item of ours is on the bus. */
  #registered: boolean | undefined;

  #verify(): boolean {
    try {
      return statusItemRegistered();
    } catch {
      return false;
    }
  }

  /**
   * Create the icon, or report that it could not be created.
   *
   * Never throws. A tray is a convenience; a main process that fails to start
   * because a desktop environment lacks a status area is not.
   */
  start(): boolean {
    if (this.#tray) return true;
    this.#registered = undefined;
    /* Asked before constructing rather than after: a Tray that is never shown
       still reports itself as created, and that is precisely the state this
       must not treat as success. */
    if (!statusAreaAvailable()) return false;
    try {
      const image = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, "base64"));
      if (image.isEmpty()) return false;
      const tray = new Tray(image);
      tray.setToolTip("MyRA");
      tray.setContextMenu(buildMenu(this.#deps));
      /* Left-click opens the window on the platforms that report it. On Linux
         the click usually goes to the menu instead, which is why "Open MyRA"
         is also the first item. */
      tray.on("click", () => this.#deps.show());
      this.#tray = tray;
      return true;
    } catch {
      return false;
    }
  }

  /** Re-read the state and redraw the menu; cheap, and called on every change. */
  refresh(): void {
    if (!this.#tray) return;
    try {
      const { model, apiUrl } = this.#deps.state();
      this.#tray.setContextMenu(buildMenu(this.#deps));
      this.#tray.setToolTip(
        apiUrl ? `MyRA — serving on ${apiUrl}` : model ? `MyRA — ${model} loaded` : "MyRA",
      );
    } catch {
      // A tray that has been destroyed by the desktop is not an error here.
    }
  }

  destroy(): void {
    try {
      this.#tray?.destroy();
    } catch {
      // Already gone.
    }
    this.#tray = undefined;
  }
}

/**
 * Claim the single-instance lock, wiring a second launch to raise the window.
 *
 * Returns false when another MyRA already holds it, in which case the caller
 * must quit immediately: two instances would each start a Lemonade daemon and
 * the second would fail to bind the API port, in both cases confusingly.
 */
export function claimSingleInstance(onSecondLaunch: () => void): boolean {
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", () => onSecondLaunch());
  return true;
}

/** Bring a window back from hidden, minimised, or merely unfocused. */
export function reveal(window: BrowserWindow | undefined): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}
