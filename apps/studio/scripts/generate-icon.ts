/**
 * Rasterize `build/icon.svg` into `build/icon.iconset/`, then build
 * `build/icon.icns` and `build/icon.png` for electron-builder. Also writes the
 * iOS/tvOS driver app icons into packages/ios-driver's asset catalog.
 *
 * Run with: pnpm build:icon
 *
 * Only needed when the artwork changes — the generated files are committed, so
 * a release build doesn't depend on this script or its native rasterizer.
 */
import { Resvg } from "@resvg/resvg-js";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const BUILD = path.join(import.meta.dirname, "..", "build");
const SVG = path.join(BUILD, "icon.svg");
const ICONSET = path.join(BUILD, "icon.iconset");

const SIZES: { name: string; size: number }[] = [
  { name: "icon_16x16.png", size: 16 },
  { name: "icon_16x16@2x.png", size: 32 },
  { name: "icon_32x32.png", size: 32 },
  { name: "icon_32x32@2x.png", size: 64 },
  { name: "icon_128x128.png", size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png", size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png", size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
];

function render(svg: Buffer, size: number): Buffer {
  const resvg = new Resvg(svg, {
    background: "rgba(0,0,0,0)",
    fitTo: { mode: "width", value: size },
  });
  return resvg.render().asPng();
}

const svg = readFileSync(SVG);

rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });

for (const { name, size } of SIZES) {
  writeFileSync(path.join(ICONSET, name), render(svg, size));
  console.log(`[icon] wrote ${name} (${size}px)`);
}

copyFileSync(path.join(ICONSET, "icon_512x512@2x.png"), path.join(BUILD, "icon.png"));

execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", path.join(BUILD, "icon.icns")], {
  stdio: "inherit",
});

console.log("[icon] done — build/icon.icns + build/icon.png");

// The XCTest driver apps wear the same icon, so they don't sit on the device's
// home screen as blank tiles. Built from icon.icon's full-bleed glyph, since
// iOS and tvOS mask the tile themselves.
const DRIVER_ASSETS = path.join(
  import.meta.dirname,
  "../../../packages/ios-driver/conductor-driver-ios/Assets.xcassets",
);
const glyphSvg = readFileSync(path.join(BUILD, "icon.icon/Assets/glyph.svg"), "utf8");
const glyphBody = glyphSvg.replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g, "");

const THEMES = {
  light: { bg: ["#ffffff", "#e9e8f3"], glyph: "#6d4dff" },
  dark: { bg: ["#2c2b36", "#131218"], glyph: "#8f78ff" },
  // Grayscale: iOS applies the user's tint.
  tinted: { bg: ["#000000", "#000000"], glyph: "#ffffff" },
} as const;
type Theme = (typeof THEMES)[keyof typeof THEMES];

// A w×h canvas: optional gradient backdrop, glyph centred at `scale` of the height.
function driverArt(
  w: number,
  h: number,
  theme: Theme,
  { bg = true, glyph = true, scale = 1 } = {},
) {
  const g = h * scale;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
    <stop offset="0" stop-color="${theme.bg[0]}" /><stop offset="1" stop-color="${theme.bg[1]}" />
  </linearGradient></defs>
  ${bg ? `<rect width="${w}" height="${h}" fill="url(#bg)" />` : ""}
  ${glyph ? `<svg x="${(w - g) / 2}" y="${(h - g) / 2}" width="${g}" height="${g}" viewBox="0 0 1024 1024">${glyphBody.replaceAll("#6d4dff", theme.glyph)}</svg>` : ""}
</svg>`);
}

function writeAsset(dir: string, contents: object, files: Record<string, Buffer> = {}) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "Contents.json"), JSON.stringify(contents, null, 2) + "\n");
  for (const [name, png] of Object.entries(files)) writeFileSync(path.join(dir, name), png);
}

const XCODE = { author: "xcode", version: 1 };

// iOS: single-size icon; Xcode derives every slot, and 18+ picks dark/tinted.
const iosIcon = (theme: Theme) => render(driverArt(1024, 1024, theme), 1024);
writeAsset(
  path.join(DRIVER_ASSETS, "AppIcon.appiconset"),
  {
    images: [
      {
        filename: "icon-light.png",
        idiom: "universal",
        platform: "ios",
        size: "1024x1024",
      },
      {
        appearances: [{ appearance: "luminosity", value: "dark" }],
        filename: "icon-dark.png",
        idiom: "universal",
        platform: "ios",
        size: "1024x1024",
      },
      {
        appearances: [{ appearance: "luminosity", value: "tinted" }],
        filename: "icon-tinted.png",
        idiom: "universal",
        platform: "ios",
        size: "1024x1024",
      },
    ],
    info: XCODE,
  },
  {
    "icon-light.png": iosIcon(THEMES.light),
    "icon-dark.png": iosIcon(THEMES.dark),
    "icon-tinted.png": iosIcon(THEMES.tinted),
  },
);

// tvOS: a two-layer parallax stack (backdrop + glyph) plus top shelf images.
const BRAND = path.join(DRIVER_ASSETS, "App Icon & Top Shelf Image.brandassets");
rmSync(BRAND, { recursive: true, force: true });

function imageStack(name: string, w: number, h: number, scales: number[]) {
  const stack = path.join(BRAND, `${name}.imagestack`);
  writeAsset(stack, {
    info: XCODE,
    layers: [{ filename: "Front.imagestacklayer" }, { filename: "Back.imagestacklayer" }],
  });
  for (const [layer, opts] of [
    ["Front", { bg: false }],
    ["Back", { glyph: false }],
  ] as const) {
    const dir = path.join(stack, `${layer}.imagestacklayer`);
    writeAsset(dir, { info: XCODE });
    const files = Object.fromEntries(
      scales.map((s) => [
        `${layer.toLowerCase()}@${s}x.png`,
        render(driverArt(w, h, THEMES.light, { ...opts, scale: 0.8 }), w * s),
      ]),
    );
    writeAsset(
      path.join(dir, "Content.imageset"),
      {
        images: scales.map((s) => ({
          filename: `${layer.toLowerCase()}@${s}x.png`,
          idiom: "tv",
          scale: `${s}x`,
        })),
        info: XCODE,
      },
      files,
    );
  }
}

function topShelf(name: string, w: number, h: number) {
  writeAsset(
    path.join(BRAND, `${name}.imageset`),
    {
      images: [1, 2].map((s) => ({
        filename: `top-shelf@${s}x.png`,
        idiom: "tv",
        scale: `${s}x`,
      })),
      info: XCODE,
    },
    Object.fromEntries(
      [1, 2].map((s) => [
        `top-shelf@${s}x.png`,
        render(driverArt(w, h, THEMES.light, { scale: 0.5 }), w * s),
      ]),
    ),
  );
}

imageStack("App Icon", 400, 240, [1, 2]);
imageStack("App Icon - App Store", 1280, 768, [1]);
topShelf("Top Shelf Image", 1920, 720);
topShelf("Top Shelf Image Wide", 2320, 720);
writeFileSync(
  path.join(BRAND, "Contents.json"),
  JSON.stringify(
    {
      assets: [
        {
          filename: "App Icon - App Store.imagestack",
          idiom: "tv",
          role: "primary-app-icon",
          size: "1280x768",
        },
        {
          filename: "App Icon.imagestack",
          idiom: "tv",
          role: "primary-app-icon",
          size: "400x240",
        },
        {
          filename: "Top Shelf Image Wide.imageset",
          idiom: "tv",
          role: "top-shelf-image-wide",
          size: "2320x720",
        },
        {
          filename: "Top Shelf Image.imageset",
          idiom: "tv",
          role: "top-shelf-image",
          size: "1920x720",
        },
      ],
      info: XCODE,
    },
    null,
    2,
  ) + "\n",
);

console.log("[icon] done — driver AppIcon + tvOS brand assets");
