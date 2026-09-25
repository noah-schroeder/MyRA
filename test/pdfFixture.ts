/**
 * A real PDF, built by hand, so page-aware extraction is tested against
 * poppler itself rather than a mock of it.
 *
 * Helvetica is one of the fourteen fonts every PDF reader must supply, so no
 * font is embedded and the file stays a few hundred bytes. Each inner array is
 * one page's lines; an empty array is a page with no text on it, which is the
 * case that keeps page numbers honest.
 */
export function buildPdf(pages: string[][]): Uint8Array {
  const objs: string[] = [];
  objs.push("<</Type/Catalog/Pages 2 0 R>>");
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs.push(`<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`);
  objs.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
  pages.forEach((lines, i) => {
    const text = lines.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) '`).join(" ");
    const stream = `BT /F1 11 Tf 40 760 Td 14 TL ${text} ET`;
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${5 + i * 2} 0 R>>`);
    objs.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
