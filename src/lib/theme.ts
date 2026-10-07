// Maps the live Omarchy theme (colors.toml) onto CSS custom properties.
import type { Contrast, Theme } from "./types";

const FALLBACK_DARK: Record<string, string> = {
  background: "#1a1b26",
  foreground: "#c0caf5",
  accent: "#7aa2f7",
  muted: "#565f89",
  selection: "#33467c",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  orange: "#ff9e64",
};

const FALLBACK_LIGHT: Record<string, string> = {
  background: "#f7f6f2",
  foreground: "#2a2f36",
  accent: "#3b6fd4",
  muted: "#8a8f98",
  selection: "#d6e2f6",
  red: "#c94a4a",
  green: "#3f8f5a",
  yellow: "#b8862b",
  blue: "#3b6fd4",
  magenta: "#9a52b8",
  cyan: "#2f8f9d",
  orange: "#c9702b",
};

// Omarchy terminal palette index for each semantic name.
const PALETTE_INDEX: Record<string, number> = {
  background: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  foreground: 7,
  muted: 8,
};

function pick(c: Record<string, string>, key: string, fb: Record<string, string>): string {
  if (c[key]) return c[key];
  const idx = PALETTE_INDEX[key];
  if (idx !== undefined && c[`color${idx}`]) return c[`color${idx}`];
  return fb[key] ?? "#888888";
}

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Readable text color on top of `bg`. */
export function onColor(bg: string, dark = "#10141a", light = "#ffffff"): string {
  return luminance(bg) > 0.45 ? dark : light;
}

function toHex([r, g, b]: number[]): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}

/** `a` weighted `t` (0..1) against `b`, in sRGB. */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return toHex(x.map((v, i) => v * t + y[i] * (1 - t)));
}

/** Per contrast level: how much of the theme background survives the pull towards near-black (or white),
 *  how much of the secondary text colours survives the pull towards the foreground, and window opacity. */
const CONTRAST: Record<Contrast, { bg: number; fg: number; dim: number; muted: number; surface: number; panel: number }> = {
  theme: { bg: 1, fg: 1, dim: 1, muted: 1, surface: 0.9, panel: 0.84 },
  higher: { bg: 0.62, fg: 0.7, dim: 0.45, muted: 0.6, surface: 0.95, panel: 0.92 },
  highest: { bg: 0.35, fg: 0.4, dim: 0.2, muted: 0.4, surface: 1, panel: 0.98 },
};

let lastTheme: Theme | null = null;
let lastOpts: { translucent: boolean; contrast: Contrast } = { translucent: false, contrast: "theme" };

export function applyTheme(theme: Theme, opts: Partial<typeof lastOpts> = {}) {
  lastTheme = theme;
  lastOpts = { ...lastOpts, ...opts };
  const { translucent, contrast } = lastOpts;
  const k = CONTRAST[contrast] ?? CONTRAST.theme;
  const boosted = contrast !== "theme";
  const c = theme.colors ?? {};
  const isLight = theme.mode === "light" || (c.background ? luminance(c.background) > 0.5 : false);
  const fb = isLight ? FALLBACK_LIGHT : FALLBACK_DARK;

  // Neutral ends the background and the text are pushed towards.
  const deep = isLight ? "#ffffff" : "#090b0e";
  const ink = isLight ? "#000000" : "#ffffff";
  const themeBg = pick(c, "background", fb);
  const themeFg = pick(c, "foreground", fb);
  const bg = boosted ? mixHex(themeBg, deep, k.bg) : themeBg;
  const fg = boosted ? mixHex(themeFg, ink, k.fg) : themeFg;
  const accent = pick(c, "accent", fb);
  const mix = (a: string, b: string, pct: number) => `color-mix(in oklab, ${a} ${pct}%, ${b})`;
  // A boosted background is derived, so the theme's own darker / lighter shades no longer match it.
  const shade = (key: string, fallback: string) => (boosted ? fallback : (c[key] ?? fallback));
  const bgDark = shade("dark_background", mixHex(bg, isLight ? "#ffffff" : "#000000", 0.88));
  const fgDim = c.dark_foreground ?? mixHex(themeFg, themeBg, 0.72);
  const muted = pick(c, "muted", fb);

  const vars: Record<string, string> = {
    "--bg": bg,
    "--bg-rgb": hexToRgb(bg).join(", "),
    "--bg-dark": bgDark,
    "--bg-darker": shade("darker_background", mixHex(bg, isLight ? "#ffffff" : "#000000", 0.76)),
    "--bg-lighter": shade("lighter_background", mix(bg, fg, 92)),
    "--fg": fg,
    "--fg-dim": boosted ? mixHex(fgDim, fg, k.dim) : fgDim,
    "--fg-bright": boosted ? ink : (c.bright_foreground ?? fg),
    "--muted": boosted ? mixHex(muted, fg, k.muted) : muted,
    "--accent": accent,
    "--accent-rgb": hexToRgb(accent).join(", "),
    "--on-accent": onColor(accent),
    "--selection": pick(c, "selection", fb),
    "--red": pick(c, "red", fb),
    "--green": pick(c, "green", fb),
    "--yellow": pick(c, "yellow", fb),
    "--blue": pick(c, "blue", fb),
    "--magenta": pick(c, "magenta", fb),
    "--cyan": pick(c, "cyan", fb),
    "--orange": c.orange ?? pick(c, "yellow", fb),
    "--surface": translucent ? `rgba(${hexToRgb(bg).join(", ")}, ${k.surface})` : bg,
    "--panel": translucent ? `rgba(${hexToRgb(bgDark).join(", ")}, ${k.panel})` : bgDark,
  };

  const root = document.documentElement;
  for (const [key, v] of Object.entries(vars)) root.style.setProperty(key, v);
  root.dataset.mode = isLight ? "light" : "dark";
  root.dataset.translucent = translucent ? "true" : "false";
  root.dataset.contrast = contrast;
  root.style.colorScheme = isLight ? "light" : "dark";
  if (theme.fontFamily) root.style.setProperty("--font-ui-system", `"${theme.fontFamily}"`);
  if (theme.monoFamily) root.style.setProperty("--font-mono-system", `"${theme.monoFamily}"`);
}

export function setTranslucent(on: boolean) {
  if (lastTheme) applyTheme(lastTheme, { translucent: on });
}

/** Account hue → color that harmonizes with the theme. */
/** Account colour. A negative hue means "follow the theme accent". */
export function hueColor(hue: number, mode: "dark" | "light" = "dark"): string {
  if (hue < 0) return "var(--accent)";
  return mode === "light" ? `oklch(0.58 0.13 ${hue})` : `oklch(0.78 0.11 ${hue})`;
}
