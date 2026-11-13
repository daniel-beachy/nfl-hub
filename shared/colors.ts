// Team colors are chosen for jerseys, not charts: black, navy and near-white are common.
// Everything drawn in a team color goes through `readableColor` first.

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`Bad hex color: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}
const toHex = (rgb: Rgb) => rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two hex colors, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(parseHex(a)), luminance(parseHex(b))].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Minimum contrast for chart lines and large text (WCAG non-text contrast). */
export const MIN_CONTRAST = 3;

/**
 * A version of a team's color that is readable on `background`: the primary if it has
 * enough contrast, else the alternate, else the primary mixed toward white or black
 * just far enough. Returns hex without '#'.
 */
export function readableColor(color: string, altColor: string, background: string): string {
  if (contrast(color, background) >= MIN_CONTRAST) return color.toLowerCase();
  if (contrast(altColor, background) >= MIN_CONTRAST) return altColor.toLowerCase();
  const from = parseHex(color);
  const target: Rgb = luminance(parseHex(background)) < 0.5 ? [255, 255, 255] : [0, 0, 0];
  for (let step = 1; step <= 20; step++) {
    const t = step / 20;
    const mixed = toHex(from.map((c, i) => c + (target[i]! - c) * t) as Rgb);
    if (contrast(mixed, background) >= MIN_CONTRAST) return mixed;
  }
  return toHex(target);
}
