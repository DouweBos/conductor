import { codeOf } from "../electron/services/cases/model";
import { toCase } from "../electron/services/cases/qaseMapping";
import type { QaseCase } from "../electron/services/cases/qaseClient";
import { assertEqual, TestSuite } from "./runner";

export const qase = new TestSuite("Qase cases");

const PROJECT = "DEMO";
const SUITES = new Map([[4, "Authentication"]]);
const FIELDS = new Map([[7, "Platform"]]);

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
