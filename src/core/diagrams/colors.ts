/**
 * Colours a model may ask a diagram to use, read strictly.
 *
 * A colour here ends up as an SVG attribute -- in a string MyRA builds by
 * concatenation for export, and as an inline style on screen -- and the text
 * it comes from is model output, which quotes the open web. So nothing is
 * passed through: every value is parsed into `#rrggbb` or refused, and a
 * refused one is named back to the model rather than guessed at. A hex code,
 * `rgb(...)` and the CSS colour names are what every model writes; `var(...)`,
 * `url(...)` and gradients are not colours and are never accepted.
 *
 * Pure and DOM-free, like the rest of this directory: the exporter runs in the
 * test suite and in main, with no `getComputedStyle` to ask.
 */

/** CSS Color Module Level 4's named colours, as hex. */
const NAMED: Record<string, string> = Object.fromEntries(
  (
    "aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc " +
    "bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a " +
    "burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 " +
    "cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b " +
    "darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b " +
    "darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 " +
    "darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f " +
    "darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff " +
    "dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 " +
    "forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 " +
    "goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 " +
    "hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa " +
    "lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 " +
    "lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 " +
    "lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa " +
    "lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 " +
    "limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa " +
    "mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 " +
    "mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 " +
    "midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead " +
    "navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 " +
    "orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 " +
    "papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 " +
    "purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 " +
    "saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee " +
    "sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 " +
    "snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 " +
    "tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 " +
    "yellow:ffff00 yellowgreen:9acd32"
  )
    .split(" ")
    .map((pair) => {
      const [name, hex] = pair.split(":");
      return [name!, `#${hex!}`];
    }),
);

/**
 * `#rrggbb`, or nothing when the text is not a colour.
 *
 * Alpha is accepted in the spelling and dropped: a translucent box over a
 * white page is just a paler colour, and the exported file stays one opaque
 * value per attribute.
 */
export function parseColor(raw: string): string | undefined {
  const text = raw.trim().toLowerCase();
  const named = NAMED[text];
  if (named) return named;

  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      return `#${[...hex.slice(0, 3)].map((c) => c + c).join("")}`;
    }
    if (hex.length === 6 || hex.length === 8) return `#${hex.slice(0, 6)}`;
    return undefined;
  }

  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(text);
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map(Number);
    if (parts.some((n) => n > 255)) return undefined;
    return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }
  return undefined;
}

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The same near-black `PAPER_THEME.text` uses, and white. */
const DARK_TEXT = "#14161a";
const LIGHT_TEXT = "#ffffff";

/**
 * Whichever of near-black or white reads better on this fill.
 *
 * A model asked for "a dark blue box" rarely also says what colour the words
 * go, and the theme's own text colour is right for one of light mode or dark
 * mode and wrong for the other -- so a filled box picks its own.
 */
export function readableTextOn(fill: string): string {
  return contrastRatio(fill, DARK_TEXT) >= contrastRatio(fill, LIGHT_TEXT) ? DARK_TEXT : LIGHT_TEXT;
}

/**
 * The grey with the same lightness as a colour.
 *
 * For a figure printed in black and white: "the red box" has to stay the
 * darker box, so each colour keeps its luminance and loses only its hue.
 */
export function toGrey(hex: string): string {
  const color = parseColor(hex);
  if (!color) return hex;
  const l = luminance(color);
  const srgb = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  const v = Math.round(Math.min(1, Math.max(0, srgb)) * 255).toString(16).padStart(2, "0");
  return `#${v}${v}${v}`;
}

/** What `classDef`, `style` and `linkStyle` can set. Every colour is `#rrggbb`. */
export interface Paint {
  fill?: string | undefined;
  stroke?: string | undefined;
  /** Mermaid's `color`: the text. On an edge, its label. */
  text?: string | undefined;
  strokeWidth?: number | undefined;
}

/** Past this a border swallows a small box, and below it one vanishes. */
const MIN_STROKE = 0.5;
const MAX_STROKE = 6;

/**
 * `fill:#f9f,stroke:#333,stroke-width:2px,color:#fff` into a `Paint`.
 *
 * Properties this does not draw -- `stroke-dasharray`, `font-size`, anything
 * else CSS has -- are skipped without comment: Mermaid source copied from
 * elsewhere carries them routinely, and none of them is a mistake worth a
 * round trip. A colour that does not parse is different, because the model
 * meant something specific by it, so those are returned by name.
 */
export function parsePaint(props: string): { paint: Paint; bad: string[] } {
  const paint: Paint = {};
  const bad: string[] = [];
  for (const part of props.split(",")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim().replace(/\s*!important$/i, "");
    if (key === "fill" || key === "stroke" || key === "color") {
      const color = parseColor(value);
      if (!color) {
        bad.push(value);
        continue;
      }
      if (key === "fill") paint.fill = color;
      else if (key === "stroke") paint.stroke = color;
      else paint.text = color;
    } else if (key === "stroke-width") {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n) && n > 0) paint.strokeWidth = Math.min(MAX_STROKE, Math.max(MIN_STROKE, n));
    }
  }
  return { paint, bad };
}

/** Later fields win, one at a time -- `classDef default`, then a class, then `style`. */
export function mergePaint(...layers: (Paint | undefined)[]): Paint | undefined {
  const out: Paint = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of ["fill", "stroke", "text", "strokeWidth"] as const) {
      if (layer[key] !== undefined) (out as Record<string, unknown>)[key] = layer[key];
    }
  }
  return Object.keys(out).length ? out : undefined;
}
