/**
 * HTML to PDF, using the browser engine the app already ships.
 *
 * pandoc's own PDF writers need a LaTeX toolchain, which is far too heavy to
 * bundle beside a desktop app; Chromium prints to PDF natively and is already
 * here. The window is offscreen and never shown.
 *
 * The page is loaded from a data: URL with node integration off and no preload,
 * so a document that came off the open web is rendered by the same sandbox that
 * renders any other untrusted page.
 */

import { BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";

const RENDER_TIMEOUT_MS = 60_000;

export function installPdfRenderer(): (html: string, outPath: string) => Promise<void> {
  return async (html, outPath) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: false, // Nothing in a printed document needs to run.
      },
    });
    try {
      const loaded = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await Promise.race([
        loaded,
        new Promise((_, fail) =>
          setTimeout(() => fail(new Error("the document took too long to render")), RENDER_TIMEOUT_MS),
        ),
      ]);
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        margins: { top: 0.6, bottom: 0.6, left: 0.7, right: 0.7 },
        pageSize: "A4",
      });
      await writeFile(outPath, pdf);
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  };
}
