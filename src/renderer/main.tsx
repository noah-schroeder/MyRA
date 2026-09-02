import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
/* Bundled, not fetched: the app is default-deny on the network and loads from
   file://, so a webfont from a CDN would simply never arrive. Vite copies
   KaTeX's fonts into the build beside the stylesheet. Imported before Karen's
   own sheet so ours has the last word. */
import "katex/dist/katex.min.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
