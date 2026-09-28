/**
 * Render the README's banner and section images, light and dark, into the
 * repo's assets/ directory. Built from the app icon's artwork so they stay in
 * step with it.
 *
 * Run with: pnpm build:readme-art (macOS: the text uses Helvetica Neue and Menlo)
 */
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BUILD = path.join(import.meta.dirname, "..", "build");
const ASSETS = path.join(import.meta.dirname, "../../../assets");
const W = 1600;

type Mode = "light" | "dark";

const PALETTE = {
  light: {
    bg: ["#faf9ff", "#ebe8f7"],
    ink: "#16151c",
    muted: "#5d5a6e",
    accent: "#6d4dff",
    soft: "#d9d4f5",
    surface: "#ffffff",
    terminal: "#16151c",
  },
  dark: {
    bg: ["#1f1e28", "#0f0e14"],
    ink: "#ffffff",
    muted: "#a6a3b8",
    accent: "#8f78ff",
    soft: "#3b3850",
    surface: "#23222d",
    terminal: "#0b0a10",
  },
} as const;

// The app icon, recoloured for dark the same way icon.icon does it.
function appIcon(mode: Mode): string {
  const svg = readFileSync(path.join(BUILD, "icon.svg"), "utf8");
  if (mode === "light") return svg;
  return svg
    .replace('stop-color="#ffffff"', 'stop-color="#2c2b36"')
    .replace('stop-color="#e9e8f3"', 'stop-color="#131218"')
    .replaceAll("#6d4dff", "#8f78ff");
}

const embed = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const rr = (x: number, y: number, w: number, h: number, r: number, attrs: string) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ${attrs}/>`;
const brackets = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  len: number,
  sw: number,
  col: string,
) => {
  const r = sw * 0.8;
  return `<path d="M${x0} ${y0 + len} V${y0 + r} Q${x0} ${y0} ${x0 + r} ${y0} H${x0 + len} M${x1 - len} ${y0} H${x1 - r} Q${x1} ${y0} ${x1} ${y0 + r} V${y0 + len} M${x1} ${y1 - len} V${y1 - r} Q${x1} ${y1} ${x1 - r} ${y1} H${x1 - len} M${x0 + len} ${y1} H${x0 + r} Q${x0} ${y1} ${x0} ${y1 - r} V${y1 - len}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>`;
};

function card(h: number, mode: Mode, body: string): string {
  const p = PALETTE[mode];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${p.bg[0]}" /><stop offset="1" stop-color="${p.bg[1]}" />
    </linearGradient>
  </defs>
  <rect width="${W}" height="${h}" rx="40" fill="url(#bg)" />
  ${body}
</svg>`;
}

// Icon + wordmark lockup.
function banner(mode: Mode): string {
  const p = PALETTE[mode];
  return card(
    640,
    mode,
    `<image x="150" y="145" width="350" height="350" href="${embed(appIcon(mode))}" />
  <text x="560" y="330" font-family="Helvetica Neue" font-weight="700" font-size="150" letter-spacing="-4" fill="${p.ink}">Conductor</text>
  <text x="566" y="410" font-family="Helvetica Neue" font-size="40" fill="${p.muted}">Mobile and web UI automation for AI agents</text>`,
  );
}

// A phone with a placeholder UI; the bottom button is what gets picked.
function phone(x: number, y: number, w: number, h: number, mode: Mode, stroke: string): string {
  const p = PALETTE[mode];
  const pad = w * 0.14;
  const lw = w - 2 * pad;
  const line = (ly: number, lwf: number, lh: number, r = 8) =>
    rr(x + pad, y + h * ly, lw * lwf, h * lh, r, `fill="${p.accent}" fill-opacity="0.16"`);
  return [
    rr(x, y, w, h, w * 0.2, `fill="${p.surface}" stroke="${stroke}" stroke-width="6"`),
    line(0.14, 0.6, 0.05),
    line(0.24, 1, 0.22, 14),
    line(0.52, 0.8, 0.04),
    line(0.59, 0.6, 0.04),
  ].join("");
}

// Terminal driving a device: the CLI section.
function cli(mode: Mode): string {
  const p = PALETTE[mode];
  const mono = (y: number, s: string, fill: string) =>
    `<text x="150" y="${y}" font-family="Menlo" font-size="34" fill="${fill}">${s}</text>`;
  return card(
    480,
    mode,
    `${rr(110, 100, 840, 280, 26, `fill="${p.terminal}"${mode === "dark" ? ` stroke="${p.soft}" stroke-width="3"` : ""}`)}
  <circle cx="148" cy="136" r="9" fill="#ff5f57" /><circle cx="176" cy="136" r="9" fill="#febc2e" /><circle cx="204" cy="136" r="9" fill="#28c840" />
  ${mono(218, `<tspan fill="#8f78ff">$</tspan> conductor tap-on "Sign In"`, "#e8e6f5")}
  ${mono(272, `<tspan fill="#5eead4">✓</tspan> tapped "Sign In"`, "#8d8aa3")}
  ${mono(326, `<tspan fill="#8f78ff">$</tspan> <tspan fill-opacity="0.5">▍</tspan>`, "#e8e6f5")}
  ${phone(1130, 50, 210, 380, mode, p.soft)}
  ${rr(1160, 312, 150, 46, 14, `fill="${p.accent}"`)}
  ${brackets(1142, 298, 1328, 372, 22, 9, p.accent)}`,
  );
}

// A flow's steps across screens, two checked and one being verified: the Studio section.
function studio(mode: Mode): string {
  const p = PALETTE[mode];
  const xs = [300, 633, 966, 1300];
  const y = 240;
  const steps = xs
    .map((cx, i) => {
      const done = i < 2;
      const screen = rr(
        cx - 75,
        115,
        150,
        250,
        32,
        `fill="${p.surface}" stroke="${done ? p.accent : p.soft}" stroke-width="7"`,
      );
      const check = done
        ? `<circle cx="${cx}" cy="${y}" r="30" fill="${p.accent}" /><path d="M${cx - 13} ${y} l10 11 l18 -22" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />`
        : "";
      return screen + check;
    })
    .join("");
  return card(
    480,
    mode,
    `<line x1="${xs[0]}" y1="${y}" x2="${xs[3]}" y2="${y}" stroke="${p.soft}" stroke-width="9" stroke-dasharray="2 20" stroke-linecap="round" />
  ${steps}
  ${brackets(xs[2] - 112, 78, xs[2] + 112, 402, 44, 13, p.accent)}`,
  );
}

const ART: Record<string, (mode: Mode) => string> = {
  banner,
  "section-cli": cli,
  "section-studio": studio,
};

for (const [name, draw] of Object.entries(ART)) {
  for (const mode of ["light", "dark"] as const) {
    const png = new Resvg(draw(mode), {
      font: { loadSystemFonts: true },
      fitTo: { mode: "width", value: W },
    })
      .render()
      .asPng();
    const file = `${name}-${mode}.png`;
    writeFileSync(path.join(ASSETS, file), png);
    console.log(`[readme-art] wrote assets/${file}`);
  }
}
