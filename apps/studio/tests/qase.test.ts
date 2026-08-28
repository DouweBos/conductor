import { commented } from "../electron/services/cases/caseComments";
import { codeOf } from "../electron/services/cases/model";
import { normalizeStepPoms } from "../electron/services/cases/stepPoms";
import { decodeEntities, fieldDef, suiteTree, toCase } from "../electron/services/cases/qaseMapping";
import type { QaseCase } from "../electron/services/cases/qaseClient";
import { assertEqual, TestSuite } from "./runner";

export const qase = new TestSuite("Qase cases");

const PROJECT = "DEMO";
const SUITES = suiteTree([{ id: 4, title: "Authentication" }]);
const FIELDS = new Map([[7, { title: "Platform", options: new Map() }]]);

/** A selectbox as `/custom_field` returns it: values are ids into `value`. */
const SELECT = new Map([
  [7, fieldDef({ id: 7, title: "Media Source", type: "selectbox", value: [
    { id: 2, title: "Plex TV" },
    { id: 4, title: "Live TV" },
  ] })],
]);

/** One recorded Qase case entity, with the integer enums the API really sends. */
function entity(overrides: Partial<QaseCase> = {}): QaseCase {
  return {
    id: 12,
    title: "User can log in with valid credentials",
    description: "The happy path.",
    preconditions: "A registered account exists.",
    postconditions: "The session is signed out.",
    severity: 1, // blocker
    priority: 2, // medium
    type: 1, // functional
    behavior: 1, // positive
    status: 0, // actual
    is_manual: true,
    suite_id: 4,
    milestone_id: null,
    steps_type: "classic",
    steps: [
      { hash: "s1", action: "Open the login screen", data: null, expected_result: "Email is focused" },
      { hash: "s2", action: "Enter valid credentials", data: "user@example.com", expected_result: null },
    ],
    custom_fields: [{ id: 7, value: "ios,android" }],
    tags: [{ title: "auth" }, { title: "p0" }],
    external_issues: [{ link: "https://tracker/AUTH-1" }],
    author_id: 91,
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-14T09:12:00Z",
    ...overrides,
  };
}

qase.test("decodes a Qase entity, integer enums and all", () => {
  const c = toCase(entity(), PROJECT, SUITES, FIELDS);

  assertEqual(c.ref, "DEMO-12", "ref");
  assertEqual(c.severity, "blocker", "severity decoded from 1");
  assertEqual(c.priority, "medium", "priority decoded from 2");
  assertEqual(c.type, "functional", "type decoded from 1");
  assertEqual(c.status, "actual", "status decoded from 0");
  assertEqual(c.suite, "Authentication", "suite title resolved");
  assertEqual(c.custom_fields, { Platform: ["ios", "android"] }, "custom field by title");
  assertEqual(c.tags, ["auth", "p0"], "flat tag list");
  assertEqual(c.external_issues, ["https://tracker/AUTH-1"], "external issues");
  assertEqual(c.steps?.[0].expected_result, "Email is focused", "step expected_result");
  assertEqual(c.steps?.[1].data, "user@example.com", "step data");
});

qase.test("a select field's option ids are resolved to their titles", () => {
  const c = toCase(entity({ custom_fields: [{ id: 7, value: "2,4" }] }), PROJECT, SUITES, SELECT);
  assertEqual(c.custom_fields, { "Media Source": ["Plex TV", "Live TV"] }, "titles, not ids");
});

qase.test("options Qase sent JSON-encoded read the same", () => {
  const fields = new Map([
    [7, fieldDef({ id: 7, title: "Media Source", value: '[{"id":2,"title":"Plex TV"}]' })],
  ]);
  const c = toCase(entity({ custom_fields: [{ id: 7, value: "[\"2\"]" }] }), PROJECT, SUITES, fields);
  assertEqual(c.custom_fields, { "Media Source": ["Plex TV"] }, "decoded either way");
});

qase.test("a value with no matching option is kept as-is", () => {
  const c = toCase(entity({ custom_fields: [{ id: 7, value: "99" }] }), PROJECT, SUITES, SELECT);
  assertEqual(c.custom_fields, { "Media Source": ["99"] }, "better a raw value than none");
});

qase.test("an unknown enum value is left off rather than guessed", () => {
  const c = toCase(entity({ severity: 99, priority: 99 }), PROJECT, SUITES, FIELDS);
  assertEqual(c.severity, undefined, "no severity");
  assertEqual(c.priority, undefined, "no priority");
  assertEqual(c.status, "actual", "status still defaults");
});

qase.test("a step with no action is dropped, not written blank", () => {
  const c = toCase(
    entity({ steps: [{ hash: "s1", action: "   " }, { hash: "s2", action: "Tap sign in" }] }),
    PROJECT,
    SUITES,
    FIELDS,
  );
  assertEqual(c.steps?.length, 1, "one usable step");
  assertEqual(c.steps?.[0].action, "Tap sign in", "the one with an action");
});

qase.test("a ref says which Qase project it belongs to", () => {
  assertEqual(codeOf("MC-12"), "MC", "mobile");
  assertEqual(codeOf("tv-4"), "TV", "case-insensitive");
  assertEqual(codeOf("not a ref"), null, "nothing to read");
});

qase.test("multi-line case prose stays commented on every line", () => {
  const lines = commented("Expected: ", "One activity is displayed.\nNote: the backend may lag.");
  assertEqual(lines, [
    "# Expected: One activity is displayed.",
    "#           Note: the backend may lag.",
  ], "the continuation is commented and aligned");
});

qase.test("a blank line inside case prose is a bare comment marker", () => {
  assertEqual(commented("", "first\n\nsecond"), ["# first", "#", "# second"], "no stray blank");
});

qase.test("HTML-escaped case prose is decoded", () => {
  const c = toCase(
    entity({
      title: "Go to a show&#039;s details page",
      steps: [{ hash: "s1", action: "Tap &quot;Play&quot;", expected_result: "1 &lt; 2 &amp; done" }],
    }),
    PROJECT,
    SUITES,
    FIELDS,
  );
  assertEqual(c.title, "Go to a show's details page", "numeric entity");
  assertEqual(c.steps?.[0].action, 'Tap "Play"', "named entity");
  assertEqual(c.steps?.[0].expected_result, "1 < 2 & done", "several in one string");
});

qase.test("a decoded ampersand is not decoded twice", () => {
  assertEqual(decodeEntities("&amp;#039;"), "&#039;", "one pass only");
  assertEqual(decodeEntities("Tom &amp; Jerry &unknown; 100%"), "Tom & Jerry &unknown; 100%", "unknown left alone");
});

qase.test("a step's page objects read back from either stored shape", () => {
  assertEqual(
    normalizeStepPoms({ pom: "pages/details/open.yaml", env: { title: "Andor" } }),
    [{ pom: "pages/details/open.yaml", env: { title: "Andor" } }],
    "the single assignment that predates the list",
  );
  assertEqual(
    normalizeStepPoms([{ pom: "pages/a.yaml" }, { pom: "pages/b.yaml" }]),
    [{ pom: "pages/a.yaml" }, { pom: "pages/b.yaml" }],
    "several, in order",
  );
  assertEqual(normalizeStepPoms({}), [], "an assignment with no page object is nothing");
});

qase.test("a case carries its suite's whole path, the way Qase nests them", () => {
  const suites = suiteTree([
    { id: 1, title: "RN (Mobile)" },
    { id: 2, title: "Community", parent_id: 1 },
    { id: 3, title: "Activity Feed", parent_id: 2 },
  ]);
  const c = toCase(entity({ suite_id: 3 }), PROJECT, suites, FIELDS);
  assertEqual(c.suite, "Activity Feed", "the leaf is still the suite");
  assertEqual(c.suite_path, ["RN (Mobile)", "Community", "Activity Feed"], "root first");
});

qase.test("a suite tree that loops on itself still resolves", () => {
  const suites = suiteTree([
    { id: 1, title: "A", parent_id: 2 },
    { id: 2, title: "B", parent_id: 1 },
  ]);
  assertEqual(suites.get(1)?.title, "A", "no hang, and a usable title");
});
