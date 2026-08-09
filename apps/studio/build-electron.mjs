import { build } from "esbuild";

// Bundle the Electron main + preload as CommonJS into dist-electron/. Mirrors
// Argus's approach: esbuild for the Node side, Vite for the renderer. No
// vite-plugin-electron.
const externals = ["electron", "chokidar", "ws", "electron-updater"];

await Promise.all([
  build({
    entryPoints: ["electron/main.ts"],
    outfile: "dist-electron/main.js",
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: true,
    external: externals,
    logLevel: "info",
  }),
  build({
    entryPoints: ["electron/preload.ts"],
    outfile: "dist-electron/preload.js",
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: true,
    external: externals,
    logLevel: "info",
  }),
]);

// Force CommonJS interpretation of the emitted .js despite any parent "type":
// "module".
import { writeFileSync } from "node:fs";
writeFileSync("dist-electron/package.json", JSON.stringify({ type: "commonjs" }));
