// Release packaging: signed + notarized dmg/zip, published to GitHub Releases.
// This is a .cjs file (not YAML) because the publish provider list must be
// authored as real JS — electron-builder's `--config.publish.N.key` CLI
// overrides replace array entries rather than merge.
//
// Tags are prefixed `studio-v` so Studio releases don't collide with the CLI's
// `v<version>` tags in this same repo. That prefix is also what the
// houwert.dev update proxy filters on to tell the two products apart.
//
// The channel comes from the version's prerelease tag (0.2.0-beta.0 → beta),
// mirroring Argus. Derived explicitly rather than via electron-builder's
// detectUpdateChannel, which only feeds the channel back into `generic`
// publish configs — for `github` the channel file would stay latest-mac.yml.
//
// Notarization is electron-builder-native (electron-builder v26): set
// `mac.notarize: true` and provide the App Store Connect API key via env vars
// APPLE_API_KEY (path to .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER. Signing certs
// come from the keychain (e.g. installed via Fastlane match) — CSC_NAME +
// CSC_IDENTITY_AUTO_DISCOVERY.
const { version } = require("./package.json");

const prereleaseChannel = /^\d+\.\d+\.\d+-([a-z]+)/.exec(version)?.[1] ?? null;

// Release body: the CHANGELOG section for this version, extracted by the
// workflow. Omitted for local runs, where electron-builder falls back to its
// own default.
const releaseNotesFile = process.env.STUDIO_RELEASE_NOTES_FILE;

module.exports = {
  appId: "dev.houwert.conductor-studio",
  productName: "Conductor Studio",
  copyright: "© Houwert",
  directories: {
    output: "release",
    buildResources: "build",
  },
  files: ["dist/**", "dist-electron/**", "package.json"],
  asar: true,
  // Copies native/conductor/ into Resources — a hook, not extraResources,
  // because electron-builder's matcher strips nested node_modules.
  afterPack: "./scripts/electron-after-pack.cjs",
  mac: {
    category: "public.app-category.developer-tools",
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] }, // zip is required for the electron-updater feed
    ],
    // Deliberately not ${productName}: GitHub rewrites spaces in uploaded asset
    // filenames, so a spaced name stops matching the url recorded in the
    // channel yml and the update download 404s.
    artifactName: "conductor-studio-${version}-${arch}.${ext}",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
  },
  ...(releaseNotesFile ? { releaseInfo: { releaseNotesFile } } : {}),
  publish: [
    {
      provider: "github",
      owner: "DouweBos",
      repo: "conductor",
      tagNamePrefix: "studio-v",
      channel: prereleaseChannel ?? "latest",
      releaseType: prereleaseChannel ? "prerelease" : "release",
    },
  ],
};
