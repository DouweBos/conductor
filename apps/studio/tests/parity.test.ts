import { slugCollision, slugForLabel } from "../electron/services/parity/labels";
import { suggestLabel } from "../app/stores/parityStore";
import type { DeviceInfo } from "../app/lib/types";
import { assert, assertEqual, TestSuite } from "./runner";

export const parity = new TestSuite("Parity");

const device = (over: Partial<DeviceInfo>): DeviceInfo => ({
  id: "dev-1",
  name: "Device",
  platform: "ios",
  state: "booted",
  ...over,
});

parity.test("a target label becomes a stable directory name", () => {
  assertEqual(slugForLabel("Android TV"), "android-tv", "spaces become dashes");
  assertEqual(slugForLabel("tvOS"), "tvos", "case is folded");
  assertEqual(slugForLabel("Lightning (web)"), "lightning-web", "punctuation is dropped");
  assertEqual(slugForLabel("  "), "target", "an empty label still has a home");
});

parity.test("labels that would share a directory are caught", () => {
  // Two targets writing to one directory would record over each other, and the
  // matrix would then compare one build against itself and call it parity.
  // A space and a dash slug the same way, so these two distinct names land in
  // one directory.
  const hit = slugCollision(["tvOS", "Android TV", "Android-TV"]);
  assert(hit !== null, "the collision is detected");
  assertEqual(hit.slug, "android-tv", "and named");
  assertEqual([hit.a, hit.b], ["Android TV", "Android-TV"], "with both culprits");
});

parity.test("distinct target names pass the collision check", () => {
  assertEqual(
    slugCollision(["tvOS", "Android TV", "VegaOS", "Lightning"]),
    null,
    "a normal four-way run is fine",
  );
});

parity.test("a device suggests a short column heading", () => {
  assertEqual(suggestLabel(device({ platform: "tvos" })), "tvOS", "tvOS");
  assertEqual(suggestLabel(device({ platform: "vega" })), "VegaOS", "Vega");
  assertEqual(suggestLabel(device({ platform: "roku" })), "Roku", "Roku");
  assertEqual(suggestLabel(device({ platform: "web" })), "Web", "web");
});

parity.test("Android tells a TV apart from a handset", () => {
  assertEqual(
    suggestLabel(device({ platform: "android", formFactor: "tv" })),
    "Android TV",
    "a TV is named as one",
  );
  assertEqual(
    suggestLabel(device({ platform: "android", formFactor: "handset" })),
    "Android",
    "a phone is not",
  );
});
