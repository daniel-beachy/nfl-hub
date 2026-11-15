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

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rn ? ((gn - bn) / d + 6) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h * 60, s, l];
}
function fromHsl(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Black, white, grey, and navy so dark it reads as black: colors with no usable hue. */
function hasNoHue(rgb: Rgb): boolean {
  const [, s, l] = toHsl(rgb);
  return s < 0.2 || l < 0.06;
}

/**
 * A version of a team's color that is readable on `background`. In order: the primary
 * as it is; for a black or grey primary, the alternate (Pittsburgh is gold, not grey);
 * otherwise the primary made lighter or darker with its hue and saturation kept, so
 * Green Bay stays green and a navy becomes a clear blue, not a washed-out slate.
 * Returns hex without '#'.
 */
export function readableColor(color: string, altColor: string, background: string): string {
  if (contrast(color, background) >= MIN_CONTRAST) return color.toLowerCase();
  const rgb = parseHex(color);
  if (hasNoHue(rgb) && contrast(altColor, background) >= MIN_CONTRAST) return altColor.toLowerCase();
  const [h, s, l] = toHsl(rgb);
  const toward = luminance(parseHex(background)) < 0.5 ? 1 : 0;
  for (let step = 1; step <= 40; step++) {
    const shifted = toHex(fromHsl(h, s, l + (toward - l) * (step / 40)));
    if (contrast(shifted, background) >= MIN_CONTRAST) return shifted;
  }
  return toward === 1 ? "ffffff" : "000000";
}
