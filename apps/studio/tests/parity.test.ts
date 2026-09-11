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

// ── Fleet ────────────────────────────────────────────────────────────────────

import { assignDevices } from "../electron/services/parity/fleet";
import { actionToStep, routeFromPath } from "../electron/services/parity/sceneRoutes";

const dev = (id: string, platform: DeviceInfo["platform"], over: Partial<DeviceInfo> = {}): DeviceInfo => ({
  id, name: id, platform, state: "booted", ...over,
});

parity.test("a need is met by a booted, free device of its platform", () => {
  const a = assignDevices(
    [{ label: "tvOS", platform: "tvos" }, { label: "Web", platform: "web" }],
    [dev("tv-1", "tvos"), dev("web-1", "web"), dev("tv-2", "tvos", { state: "shutdown" })],
  );
  assertEqual(a.assigned, { tvOS: "tv-1", Web: "web-1" }, "one each");
  assertEqual(a.unmet, [], "nothing unmet");
});

parity.test("a reserved device is not offered, and a need it leaves is named", () => {
  const a = assignDevices(
    [{ label: "tvOS", platform: "tvos" }],
    [dev("tv-1", "tvos", { reservedBy: "another agent" })],
  );
  assertEqual(a.assigned, {}, "nothing assigned");
  assert(a.unmet[0].includes("tvOS") && a.unmet[0].includes("tvos"), `says what is missing: ${a.unmet[0]}`);
});

parity.test("the device used last time is preferred when it qualifies", () => {
  const a = assignDevices(
    [{ label: "tvOS", platform: "tvos", preferredDeviceId: "tv-2" }],
    [dev("tv-1", "tvos"), dev("tv-2", "tvos")],
  );
  assertEqual(a.assigned.tvOS, "tv-2", "the remembered simulator");
});

parity.test("two needs never share a device, and Android form factor is honoured", () => {
  const a = assignDevices(
    [
      { label: "Android TV", platform: "android", formFactor: "tv" },
      { label: "Android", platform: "android", formFactor: "handset" },
      { label: "Android 2", platform: "android", formFactor: "handset" },
    ],
    [dev("atv", "android", { formFactor: "tv" }), dev("phone", "android", { formFactor: "handset" })],
    new Set(["something-else"]),
  );
  assertEqual(a.assigned, { "Android TV": "atv", Android: "phone" }, "each to its kind");
  assertEqual(a.unmet.length, 1, "the third has no phone left");
});

// ── Routes from the scene graph ──────────────────────────────────────────────

parity.test("recorded actions become replayable steps", () => {
  assertEqual(actionToStep("tapOn: point 0.5,0.25").step, { kind: "tap", x: 0.5, y: 0.25 }, "tap");
  assertEqual(actionToStep("pressKey: Remote Dpad Down").step, { kind: "key", key: "Remote Dpad Down" }, "key");
  assertEqual(actionToStep("swipe 0.5,0.8 → 0.5,0.2").step, { kind: "swipe", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2 }, "swipe");
  assertEqual(actionToStep("launchApp: com.example.tv").appId, "com.example.tv", "launch becomes the app");
});

parity.test("a text selector cannot be replayed blind, and says so", () => {
  const p = actionToStep('tapOn: "Login"');
  assert(!p.step && (p.reason?.startsWith("not replayable") ?? false), "refused with a reason");
});

parity.test("a found path becomes a route, with the launch as its app", () => {
  const r = routeFromPath({
    nodeIds: ["a", "b", "c"],
    cost: 2,
    steps: [
      { from: "a", to: "b", action: "launchApp: com.example.tv" },
      { from: "b", to: "c", action: "pressKey: Remote Dpad Down" },
    ],
  });
  assertEqual(r.route.appId, "com.example.tv", "app from the launch edge");
  assertEqual(r.route.steps.length, 1, "one replayable step");
  assert(r.replayable, "replayable");
});

parity.test("a path with a text selector is not replayable", () => {
  const r = routeFromPath({
    nodeIds: ["a", "b"], cost: 1,
    steps: [{ from: "a", to: "b", action: 'tapOn: "Settings"' }],
  });
  assert(!r.replayable && r.unreplayable.length === 1, "flagged, not silently wrong");
});

// ── Planner ──────────────────────────────────────────────────────────────────
import {
  buildPlannerBrief,
  mergeProposals,
  parsePlannerAnswer,
  proposeFromSceneGraph,
  rootsOf,
} from "../electron/services/parity/planDecision";
import type { SceneGraph } from "../app/lib/types";

const graph = (): SceneGraph => ({
  version: 2,
  app: { appId: "com.example.tv", appName: "Example", platform: "tvos", key: "tvos-com.example.tv" },
  nodes: [
    { id: "screen-1", label: "Splash", signature: "a" },
    { id: "screen-2", label: "Home", signature: "b" },
    { id: "screen-3", label: "Detail", signature: "c" },
    { id: "screen-4", label: "Settings", signature: "d" },
    { id: "screen-5", label: "Player", signature: "e" },
  ],
  edges: [
    { from: "screen-1", to: "screen-2", action: "launchApp: com.example.tv" },
    { from: "screen-2", to: "screen-3", action: "pressKey: Remote Select" },
    { from: "screen-2", to: "screen-4", action: "tapOn: point 0.9,0.05" },
    { from: "screen-3", to: "screen-5", action: "pressKey: Remote Select" },
    // Player is also reachable through a text selector — which the graph
    // proposes but cannot replay blind.
    { from: "screen-4", to: "screen-5", action: 'tapOn: "Resume"' },
  ],
});

parity.test("the launch edge names where a walk starts", () => {
  const r = rootsOf(graph());
  assertEqual(r.ids, ["screen-2"], "the launched screen is the root, not the splash it came from");
  assertEqual(r.appId, "com.example.tv", "and the launch names the app");
});

parity.test("with no launch recorded, screens nothing leads to are the roots", () => {
  const g = graph();
  g.edges = g.edges.filter((e) => !e.action.startsWith("launchApp"));
  assertEqual(rootsOf(g).ids, ["screen-1", "screen-2"], "the splash and the home it launched into both have no way in");
});

parity.test("the graph proposes every screen, shallowest first, with a replayable route", () => {
  const proposals = proposeFromSceneGraph(graph());
  assertEqual(
    proposals.map((p) => p.name),
    ["Home", "Detail", "Settings", "Player", "Splash"],
    "entry screen first, then one step out, then two; the unreachable splash last",
  );
  const home = proposals[0];
  assertEqual(home.route?.appId, "com.example.tv", "the entry screen's route is the launch itself");
  assertEqual(home.route?.steps.length, 0, "with no steps");
  const player = proposals.find((p) => p.name === "Player")!;
  assertEqual(player.route?.steps.length, 2, "the shortest path through Detail is chosen");
  assert(!player.unreplayable, "and it avoids the text-selector edge");
  const splash = proposals.find((p) => p.name === "Splash")!;
  assert(!splash.route, "a screen no root reaches has no route");
  assert(splash.rationale?.includes("not reached") === true, "and says so");
  assert(proposals.every((p) => p.source === "scene-graph"), "all attributed to the graph");
});

parity.test("the planner's JSON answer is read from its last fence, deduped by name", () => {
  const text = [
    "Looking at the router...",
    "```json",
    '{ "screens": [ { "name": "Home" } ] }',
    "```",
    "Actually, here is the full list:",
    "```json",
    '{ "screens": [',
    '  { "name": "Home", "rationale": "entry", "deepLink": "example://home" },',
    '  { "name": "home", "rationale": "duplicate" },',
    '  { "name": "Search", "rationale": "new" },',
    '  { "name": "" }',
    "] }",
    "```",
  ].join("\n");
  const answer = parsePlannerAnswer(text, "com.example.tv");
  assert(!answer.error, "no error");
  assertEqual(answer.proposals.map((p) => p.name), ["Home", "Search"], "the last fence, without duplicates or blanks");
  assertEqual(answer.proposals[0].route, { appId: "com.example.tv", deepLink: "example://home", steps: [] }, "a deep link becomes a route");
  assert(!answer.proposals[1].route, "no deep link, no route");
  assert(answer.proposals.every((p) => p.source === "agent"), "attributed to the agent");
});

parity.test("a planner that answers in prose is reported, not guessed", () => {
  const answer = parsePlannerAnswer("The app has a Home screen and a Detail screen.");
  assertEqual(answer.proposals, [], "nothing proposed");
  assert(answer.error?.includes("no JSON") === true, "and the reason is named");
  const wrongShape = parsePlannerAnswer('{ "pages": [] }');
  assert(wrongShape.error?.includes("screens") === true, "a JSON answer without the list is named too");
});

parity.test("re-planning merges by name and keeps what a person already did", () => {
  const fromGraph = proposeFromSceneGraph(graph());
  const queued = fromGraph.map((p) => (p.name === "Home" ? { ...p, goalId: "goal-1" } : p));
  const fromAgent = parsePlannerAnswer(
    '```json\n{ "screens": [ { "name": "home", "rationale": "entry", "deepLink": "example://home" }, { "name": "Search", "rationale": "new" } ] }\n```',
    "com.example.tv",
  ).proposals;
  const merged = mergeProposals(queued, fromAgent);
  assertEqual(merged.length, fromGraph.length + 1, "one new screen; the rest paired by name");
  const home = merged.find((p) => p.name === "Home")!;
  assertEqual(home.id, "graph:screen-2", "the existing entry keeps its identity");
  assertEqual(home.goalId, "goal-1", "and the goal it became");
  assertEqual(home.route?.deepLink, "example://home", "a deep link beats a replayed route");
  assertEqual(home.source, "scene-graph", "the graph still owns it");
  assert(home.rationale?.includes("entry") === true, "the agent's rationale is kept alongside");
  assertEqual(merged[merged.length - 1].name, "Search", "new screens append at the end");
  // Running the same plan again changes nothing.
  assertEqual(mergeProposals(merged, fromGraph).length, merged.length, "idempotent");
});

parity.test("the planner brief names the source, the known screens, and demands JSON", () => {
  const brief = buildPlannerBrief({
    sourceDir: "/repo/apps/tv",
    appId: "com.example.tv",
    platform: "tvos",
    known: [{ name: "Home", route: "launch com.example.tv" }],
  });
  assert(brief.includes("/repo/apps/tv"), "where to read");
  assert(brief.includes("com.example.tv"), "which app");
  assert(brief.includes("- Home (launch com.example.tv)"), "what is already known");
  assert(brief.includes('"screens"'), "the shape of the answer");
  assert(/Do not modify files/.test(brief), "and that it is read-only");
});
