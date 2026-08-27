import { LemonadeServer } from "./src/main/runtime/lemonade.ts";
const S = process.argv[2]!;
const srv = new LemonadeServer();
const st = await srv.start({ binary: `${S}/inst/lemonade-embeddable-11.8.0-ubuntu-x64/lemond`, cacheDir: `${S}/inst-cache`, configDir: `${S}/m-config`, modelsDir: "/home/coding/.config/Karen/models" });
const H = srv.authHeaders();
for (const p of ["/models", "/models?all=true", "/models?filter=all", "/models?downloaded=false", "/registry/search?query=qwen&limit=3"]) {
  const r = await fetch(`${st.adminUrl}${p}`, { headers: H });
  const t = await r.text();
  let n = "?";
  try { const j = JSON.parse(t); n = String((j.data ?? j.results ?? j).length ?? "obj"); } catch { /* */ }
  console.log(`${p.padEnd(38)} ${r.status}  count=${n}  ${t.slice(0, 90).replace(/\n/g, "")}`);
}
await srv.stop();
