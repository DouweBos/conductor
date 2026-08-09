// Release packaging: signed + notarized dmg/zip, published to GitHub Releases so
// electron-updater can serve updates. This is a .cjs file (not YAML) because the
// publish provider list must be authored as real JS — electron-builder's
// `--config.publish.N.key` CLI overrides replace array entries rather than merge.
//
// Notarization is electron-builder-native (electron-builder v26): set
// `mac.notarize: true` and provide the App Store Connect API key via env vars
// APPLE_API_KEY (path to .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER. Signing certs
// come from the keychain (e.g. installed via Fastlane match) — CSC_NAME +
// CSC_IDENTITY_AUTO_DISCOVERY.
const channel = process.env.STUDIO_CHANNEL || "latest";
const isPrerelease = channel !== "latest";

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
  mac: {
    category: "public.app-category.developer-tools",
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] }, // zip is required for the electron-updater feed
    ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
  },
  dmg: {
    artifactName: "${productName}-${version}-${arch}.${ext}",
  },
  publish: [
    {
      provider: "github",
      owner: "DouweBos",
      repo: "conductor",
      channel,
      releaseType: isPrerelease ? "prerelease" : "release",
    },
  ],
};
