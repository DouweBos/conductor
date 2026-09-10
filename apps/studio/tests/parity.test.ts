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

// ── The round-1 barrier ──────────────────────────────────────────────────────

import { universalBlockingFindings } from "../electron/services/parity/convergeDecision";
import type { ParityFinding } from "../app/lib/types";

const missing = (identifier: string, detail = "gone"): ParityFinding => ({
  kind: "missing",
  severity: "blocking",
  detail,
  identifier,
  role: "button",
});

parity.test("a finding every target reports is universal", () => {
  const firsts = ["tvOS", "Android TV", "VegaOS"].map((_, i) =>
    round(1, 1, { passed: false, findings: [missing("browse-button", `worded ${i}`)] }),
  );
  const u = universalBlockingFindings(firsts);
  assertEqual(u.length, 1, "one universal finding, whatever the wording");
  assertEqual(u[0].identifier, "browse-button", "and it is the shared one");
});

parity.test("a finding on one target is not universal", () => {
  const firsts = [
    round(1, 2, { passed: false, findings: [missing("browse-button"), missing("help-button")] }),
    round(1, 1, { passed: false, findings: [missing("browse-button")] }),
  ];
  const u = universalBlockingFindings(firsts);
  assertEqual(u.map((f) => f.identifier), ["browse-button"], "only the shared one");
});

parity.test("advisory findings never trip the barrier", () => {
  const moved: ParityFinding = { kind: "moved", severity: "advisory", detail: "shifted", identifier: "x" };
  const firsts = [round(1, 0, { passed: false, findings: [moved] }), round(1, 0, { passed: false, findings: [moved] })];
  assertEqual(universalBlockingFindings(firsts).length, 0, "layout drift on every target is still not a reference bug");
});

parity.test("one target cannot be universal", () => {
  assertEqual(
    universalBlockingFindings([round(1, 1, { passed: false, findings: [missing("x")] })]).length,
    0,
    "nothing to agree with",
  );
});

// ── Memory, recipes, routes ──────────────────────────────────────────────────

import { parseMemory, renderMemoryForBrief } from "../electron/services/parity/memory";
import { normalise } from "../electron/services/parity/config";
import { describeStep } from "../electron/services/parity/routes";

parity.test("memory round-trips through its file format", () => {
  const file = [
    "## 2026-09-10T12:00:00.000Z · agent",
    "Build with `xcodebuild -scheme App`.",
    "",
    "## 2026-09-10T12:05:00.000Z · reviewer",
    "The focus ring is the wrong colour.",
    "Two lines.",
    "",
  ].join("\n");
  const m = parseMemory("tvOS", file);
  assertEqual(m.entries.length, 2, "two entries");
  assertEqual(m.entries[0].source, "agent", "first is the agent's");
  assertEqual(m.entries[1].source, "reviewer", "second is the reviewer's");
  assert(m.entries[1].text.includes("Two lines."), "multi-line bodies survive");
});

parity.test("hand-edited text before any header is kept, not lost", () => {
  const m = parseMemory("tvOS", "someone typed this by hand\n\n## 2026-09-10T12:00:00.000Z · loop\nfact\n");
  assertEqual(m.entries.length, 2, "the preamble becomes an entry");
  assert(m.entries[0].text.includes("by hand"), "and keeps its text");
});

parity.test("the brief keeps the newest memory when the cap bites", () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({
    at: i,
    source: "agent" as const,
    text: `note number ${i} ${"x".repeat(200)}`,
  }));
  const out = renderMemoryForBrief({ label: "tvOS", entries }, 2_000);
  assert(out.includes("note number 39"), "the newest is present");
  assert(!out.includes("note number 0 "), "the oldest was dropped");
  assert(out.includes("older note"), "and the drop is declared");
});

parity.test("an empty memory renders nothing, so the brief has no empty heading", () => {
  assertEqual(renderMemoryForBrief({ label: "x", entries: [] }), "", "empty");
});

parity.test("a recipe drops blank commands rather than running an empty string", () => {
  const r = normalise({
    label: "tvOS",
    platform: "tvos",
    appId: "  ",
    build: { command: "  xcodebuild  ", cwd: " apps/tvos " },
    reload: { command: "" },
    test: { command: "   " },
  });
  assert(r.build?.command === "xcodebuild" && r.build.cwd === "apps/tvos", "build is kept and trimmed");
  assert(!("reload" in r) && !("test" in r) && !("appId" in r), "blanks are gone");
});

parity.test("a route step describes itself for the log", () => {
  assertEqual(describeStep({ kind: "key", key: "Remote Dpad Down" }), "press Remote Dpad Down", "key");
  assert(describeStep({ kind: "tap", x: 0.5, y: 0.25 }).startsWith("tap 0.500,0.250"), "tap");
});

// ── The campaign's decisions ─────────────────────────────────────────────────

import {
  applyConvergence,
  applyDrift,
  burndown,
  nextGoal,
  runnableTargets,
} from "../electron/services/parity/campaignPlan";
import type { ConvergeProgress, ParityGoal } from "../app/lib/types";

const goal = (id: string, status: ParityGoal["status"]): ParityGoal => ({
  id,
  checkpoint: id,
  referenceDir: `/ref/${id}`,
  referenceLabel: "Reference",
  referenceDeviceId: "ref-dev",
  referenceCapturedAt: 0,
  targets: Object.keys(status).map((label) => ({ label, deviceId: `dev-${label}`, platform: "tvos" as const })),
  status,
  createdAt: 0,
  updatedAt: 0,
});

parity.test("the next goal is the first with anything left to do", () => {
  const goals = [
    goal("home", { tvOS: "accepted", VegaOS: "accepted" }),
    goal("detail", { tvOS: "accepted", VegaOS: "stalled" }),
    goal("search", { tvOS: "pending", VegaOS: "pending" }),
  ];
  assertEqual(nextGoal(goals)?.id, "detail", "a stalled target is retried before new work");
  assertEqual(runnableTargets(goals[1]), ["VegaOS"], "and only that target is re-run");
});

parity.test("a goal at review is finished as far as the queue is concerned", () => {
  const goals = [goal("home", { tvOS: "review", VegaOS: "accepted" })];
  assertEqual(nextGoal(goals), undefined, "review waits for a human, not the queue");
});

parity.test("a finished convergence folds back into the goal", () => {
  const progress: ConvergeProgress = {
    goalId: "x",
    checkpoint: "home",
    referenceLabel: "Reference",
    referenceDir: "/ref/home",
    running: false,
    startedAt: 0,
    targets: [
      { label: "tvOS", deviceId: "a", platform: "tvos", phase: "awaiting-review", attempts: [] },
      { label: "VegaOS", deviceId: "b", platform: "vega", phase: "stalled", attempts: [] },
      { label: "Web", deviceId: "c", platform: "web", phase: "awaiting-review", attempts: [], accepted: true },
    ],
  };
  const next = applyConvergence(goal("home", { tvOS: "converging", VegaOS: "converging", Web: "converging" }), progress);
  assertEqual(next.status, { tvOS: "review", VegaOS: "stalled", Web: "accepted" }, "each target lands where the loop left it");
});

parity.test("a moved reference sends accepted work back for recheck, nothing else", () => {
  const next = applyDrift(
    goal("home", { tvOS: "accepted", VegaOS: "stalled", Web: "pending" }),
    "/ref/home-2",
    { blocking: 2, summary: "Browse moved" },
  );
  assertEqual(next.status, { tvOS: "recheck", VegaOS: "stalled", Web: "pending" }, "only accepted flips");
  assertEqual(next.referenceDir, "/ref/home-2", "and the goal is held to the new reference");
  assert(next.drift?.blocking === 2, "with the drift recorded");
});

parity.test("burndown counts per target and overall", () => {
  const b = burndown([
    goal("home", { tvOS: "accepted", VegaOS: "review" }),
    goal("detail", { tvOS: "accepted", VegaOS: "recheck" }),
    goal("search", { tvOS: "stalled", VegaOS: "pending" }),
  ]);
  assertEqual(b.accepted, 2, "two accepted");
  assertEqual(b.acceptedByTarget, { tvOS: 2 }, "both by tvOS");
  assertEqual([b.review, b.recheck, b.stalled, b.pending], [1, 1, 1, 1], "the rest are counted");
});

// ── The adversarial reviewer ─────────────────────────────────────────────────

import { buildReviewBrief, parseVerdict, REVIEW_DIFF_CAP } from "../electron/services/parity/reviewDecision";

parity.test("a reviewer's OK is read from its last VERDICT line", () => {
  const v = parseVerdict("I looked at both files.\nAt first I thought VERDICT: REJECT but no.\n\n**VERDICT: OK**\n");
  assertEqual(v.verdict, "ok", "the final decision wins over thinking aloud");
});

parity.test("a rejection carries its reasons, inline and on following lines", () => {
  const v = parseVerdict("VERDICT: REJECT — the button is hidden\n- Foo.swift sets alpha to 0\n- test skipped");
  assert(v.verdict === "reject", "rejected");
  if (v.verdict === "reject") {
    assert(v.reasons.includes("hidden") && v.reasons.includes("alpha to 0"), `reasons kept: ${v.reasons}`);
  }
});

parity.test("a reviewer that never answers is reported as such, not guessed", () => {
  assertEqual(parseVerdict("Looks fine to me I suppose.").verdict, "none", "no VERDICT line");
  assertEqual(parseVerdict("VERDICT: maybe?").verdict, "none", "an unreadable verdict is not an OK");
});

parity.test("the review brief names the gaming patterns and demands one verdict line", () => {
  const brief = buildReviewBrief({
    targetLabel: "tvOS",
    referenceLabel: "RN",
    checkpoint: "home",
    fixed: [{ kind: "missing", severity: "blocking", detail: "button Browse is gone", identifier: "browse-button" }],
    referenceSnapshotPath: "/ref/home.json",
    targetSnapshotPath: "/att/home.json",
    diff: "+ let x = 1",
    untracked: ["apps/tvos/New.swift"],
  });
  for (const must of ["renders nothing", "test deleted", "hard-coded", "VERDICT: OK", "VERDICT: REJECT", "[browse-button]", "New.swift", "Do not edit"]) {
    assert(brief.includes(must), `brief mentions "${must}"`);
  }
});

parity.test("a huge diff is truncated with a note, not dropped silently", () => {
  const brief = buildReviewBrief({
    targetLabel: "t", referenceLabel: "r", checkpoint: "c", fixed: [],
    referenceSnapshotPath: "a", targetSnapshotPath: "b",
    diff: "x".repeat(REVIEW_DIFF_CAP + 500), untracked: [],
  });
  assert(brief.includes("diff truncated"), "says it was cut");
  assert(brief.length < REVIEW_DIFF_CAP + 3_000, "and actually cut it");
});

// ── Interaction parity and cost ──────────────────────────────────────────────

import { mergeCheckpointDiffs } from "../electron/services/parity/convergeDecision";

parity.test("a multi-step goal passes only when every checkpoint does", () => {
  const ok = mergeCheckpointDiffs(
    ["home", "home/1", "home/2"],
    [
      { name: "home", passed: true, findings: [] },
      { name: "home/1", passed: true, findings: [] },
      { name: "home/2", passed: true, findings: [] },
    ],
  );
  assert(ok.passed && ok.blocking === 0, "all three match");

  const focusWrong = mergeCheckpointDiffs(
    ["home", "home/1"],
    [
      { name: "home", passed: true, findings: [] },
      { name: "home/1", passed: false, findings: [{ kind: "focus", severity: "blocking", detail: "Browse has focus in the reference but not in the candidate" }] },
    ],
  );
  assert(!focusWrong.passed, "one wrong step fails the round");
  assert(focusWrong.findings[0].detail.startsWith("[home/1] "), "findings say which step");
});

parity.test("a step whose checkpoint was never captured blocks, and says why", () => {
  const m = mergeCheckpointDiffs(["home", "home/1"], [{ name: "home", passed: true, findings: [] }]);
  assert(!m.passed, "missing step fails");
  assertEqual(m.findings[0].kind, "checkpoint-missing", "reported as a missing checkpoint");
  assert(m.findings[0].detail.includes("did not land"), "with the honest reading");
});

parity.test("a single-checkpoint goal is not prefixed", () => {
  const m = mergeCheckpointDiffs(["home"], [{ name: "home", passed: false, findings: [{ kind: "missing", severity: "blocking", detail: "gone" }] }]);
  assertEqual(m.findings[0].detail, "gone", "no [home] prefix when there is only one");
});

parity.test("cost is folded into the goal across convergence runs", () => {
  const before = goal("home", { tvOS: "converging" });
  const progress: ConvergeProgress = {
    goalId: "x", checkpoint: "home", referenceLabel: "R", referenceDir: "/r", running: false, startedAt: 0,
    targets: [{
      label: "tvOS", deviceId: "a", platform: "tvos", phase: "awaiting-review",
      attempts: [
        { index: 1, startedAt: 0, blocking: 2, advisory: 0, passed: false, findings: [], dir: "d1", agent: { costUsd: 0.5, durationMs: 60_000 }, steps: [{ step: "build", ok: true, durationMs: 120_000, output: "" }] },
        { index: 2, startedAt: 0, blocking: 0, advisory: 0, passed: true, findings: [], dir: "d2", agent: { costUsd: 0.25, durationMs: 30_000 } },
      ],
    }],
  };
  const once = applyConvergence(before, progress);
  assertEqual(once.spent, { usd: 0.75, ms: 210_000, rounds: 2 }, "summed over rounds and steps");
  const twice = applyConvergence(once, progress);
  assertEqual(twice.spent?.rounds, 4, "a second run accumulates rather than replaces");
  assertEqual(burndown([twice]).spentUsd, 1.5, "and the burndown totals it");
});
