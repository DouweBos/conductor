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

// ── The convergence loop's stop conditions ───────────────────────────────────

import { decideNextRound } from "../electron/services/parity/convergeDecision";
import type { ConvergeAttempt } from "../app/lib/types";

const round = (index: number, blocking: number, over: Partial<ConvergeAttempt> = {}): ConvergeAttempt => ({
  index,
  startedAt: 0,
  blocking,
  advisory: 0,
  passed: blocking === 0 && over.passed !== false,
  findings: [],
  dir: `attempt-${index}`,
  ...over,
});

const BUDGET = { maxAttempts: 8, patience: 3 };

parity.test("a matching round opens the gate for review, not for done", () => {
  const d = decideNextRound([round(1, 5, { passed: false }), round(2, 0)], BUDGET);
  assertEqual(d.next, "review", "parity sends it to review");
});

parity.test("a round that improved earns another", () => {
  const d = decideNextRound([round(1, 9, { passed: false }), round(2, 4, { passed: false })], BUDGET);
  assertEqual(d.next, "continue", "still closing on the reference");
});

parity.test("no improvement for `patience` rounds stops the loop", () => {
  // 5 → 5 → 5 → 5: three rounds after the best, so it gives up.
  const attempts = [1, 2, 3, 4].map((i) => round(i, 5, { passed: false }));
  const d = decideNextRound(attempts, BUDGET);
  assertEqual(d.next, "stop", "stuck");
  assert(
    d.next === "stop" && d.reason.includes("without reducing"),
    `the reason names the stall, got: ${d.next === "stop" ? d.reason : ""}`,
  );
});

parity.test("progress is judged against the best round, not the previous one", () => {
  // 5 → 3 → 4: worse than last round but still better than where it started,
  // so the agent has made progress and gets to keep going.
  const attempts = [round(1, 5, { passed: false }), round(2, 3, { passed: false }), round(3, 4, { passed: false })];
  assertEqual(decideNextRound(attempts, BUDGET).next, "continue", "one bad round is not a stall");
});

parity.test("patience is spent even when rounds keep improving slightly", () => {
  // Every round improves, so the loop never stalls — it runs out of rounds.
  const attempts = [9, 8, 7, 6, 5, 4, 3, 2].map((b, i) => round(i + 1, b, { passed: false }));
  const d = decideNextRound(attempts, BUDGET);
  assertEqual(d.next, "stop", "the budget is finite");
  assert(
    d.next === "stop" && d.reason.includes("out of rounds"),
    "and says so rather than blaming a stall",
  );
});

parity.test("a capture failure stops the target immediately", () => {
  const d = decideNextRound([round(1, 0, { passed: false, error: "device went away" })], BUDGET);
  assertEqual(d.next, "stop", "no point continuing");
  assert(d.next === "stop" && d.reason.includes("device went away"), "the reason is carried through");
});

parity.test("the first round always gets a chance", () => {
  assertEqual(decideNextRound([], BUDGET).next, "continue", "nothing measured yet");
  assertEqual(
    decideNextRound([round(1, 3, { passed: false })], BUDGET).next,
    "continue",
    "one failing round is not a stall",
  );
});

parity.test("patience of 1 stops on the first round that does not improve", () => {
  const attempts = [round(1, 4, { passed: false }), round(2, 4, { passed: false })];
  assertEqual(
    decideNextRound(attempts, { maxAttempts: 8, patience: 1 }).next,
    "stop",
    "an impatient budget gives up at once",
  );
});
