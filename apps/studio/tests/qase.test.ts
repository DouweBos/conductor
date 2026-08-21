import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { parseCase } from "../electron/services/cases/caseFile";
import { pullCases } from "../electron/services/cases/qaseSync";
import { assert, assertEqual, TestSuite } from "./runner";

export const qase = new TestSuite("Qase datasource");

const PROJECT = "DEMO";

/** One recorded Qase case entity, with the integer enums the API really sends. */
function entity(overrides: Record<string, unknown> = {}) {
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

/**
 * Stand in for api.qase.io. Serves `cases` across pages of `pageSize` so the
 * client's pagination is actually exercised rather than assumed.
 */
function fakeQase(cases: Record<string, unknown>[], pageSize = 100) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    calls.push(href);
    const offset = Number(new URL(href).searchParams.get("offset") ?? 0);
    const limit = Number(new URL(href).searchParams.get("limit") ?? pageSize);
    const body = (entities: unknown[], total: number) => ({
      ok: true,
      status: 200,
      json: async () => ({ status: true, result: { total, entities } }),
    });

    if (href.includes("/suite/")) return body([{ id: 4, title: "Authentication" }], 1);
    if (href.includes("/custom_field")) return body([{ id: 7, title: "Platform" }], 1);
    const page = cases.slice(offset, offset + Math.min(limit, pageSize));
    return body(page, cases.length);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function store(): string {
  return mkdtempSync(path.join(tmpdir(), "conductor-qase-"));
}

function readOnly(dir: string) {
  const file = readdirSync(dir).find((f) => f.endsWith(".yaml"))!;
  const abs = path.join(dir, file);
  return {
    file,
    text: readFileSync(abs, "utf8"),
    parsed: parseCase(parseYaml(readFileSync(abs, "utf8")) as Record<string, unknown>, abs, PROJECT)!,
  };
}

qase.test("maps a Qase entity onto a case file, decoding its integer enums", async () => {
  const dir = store();
  const fake = fakeQase([entity()]);
  try {
    const summary = await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
    assertEqual([summary.pulled, summary.created, summary.updated], [1, 1, 0], "pull counts");

    const { file, parsed } = readOnly(dir);
    assertEqual(file, "DEMO-12-user-can-log-in-with-valid-credentials.yaml", "file name");
    assertEqual(parsed.ref, "DEMO-12", "ref");
    assertEqual(parsed.severity, "blocker", "severity decoded from 1");
    assertEqual(parsed.priority, "medium", "priority decoded from 2");
    assertEqual(parsed.type, "functional", "type decoded from 1");
    assertEqual(parsed.status, "actual", "status decoded from 0");
    assertEqual(parsed.suite, "Authentication", "suite title resolved");
    assertEqual(parsed.custom_fields, { Platform: ["ios", "android"] }, "custom field by title");
    assertEqual(parsed.tags, ["auth", "p0"], "flat tag list");
    assertEqual(parsed.external_issues, ["https://tracker/AUTH-1"], "external issues");
    assertEqual(parsed.steps?.[0].expected_result, "Email is focused", "step expected_result");
    assertEqual(parsed.steps?.[1].data, "user@example.com", "step data");
  } finally {
    fake.restore();
  }
});

qase.test("writes enums as names, not Qase's integers", async () => {
  const dir = store();
  const fake = fakeQase([entity()]);
  try {
    await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
    const { text } = readOnly(dir);
    assert(text.includes("severity: blocker"), "severity is written as a name");
    assert(!/severity: \d/.test(text), "no raw integer severity");
    assert(text.includes("expected_result:"), "Qase's step key is kept verbatim");
  } finally {
    fake.restore();
  }
});

qase.test("pages through everything the API has", async () => {
  const dir = store();
  const many = Array.from({ length: 250 }, (_, i) => entity({ id: i + 1, title: `Case ${i + 1}` }));
  const fake = fakeQase(many);
  try {
    const summary = await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
    assertEqual(summary.pulled, 250, "every page pulled");
    assertEqual(readdirSync(dir).filter((f) => f.endsWith(".yaml")).length, 250, "files written");
  } finally {
    fake.restore();
  }
});

qase.test("a re-pull keeps the conductor block and per-step page objects", async () => {
  const dir = store();
  let fake = fakeQase([entity()]);
  try {
    await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
  } finally {
    fake.restore();
  }

  // Someone links a flow and assigns a page object, as they would in Studio.
  const { file } = readOnly(dir);
  const abs = path.join(dir, file);
  writeFileSync(
    abs,
    `${readFileSync(abs, "utf8")}conductor:\n  flow: flows/cases/login.yaml\n  steps:\n    - pom: pages/login/open.yaml\n      env: { path: login }\n    - {}\n`,
    "utf8",
  );

  // Qase edits the title and the second step; the first step is untouched.
  fake = fakeQase([
    entity({
      title: "User signs in with valid credentials",
      steps: [
        { hash: "s1", action: "Open the login screen", data: null, expected_result: "Email is focused" },
        { hash: "s2", action: "Type the credentials", data: "user@example.com", expected_result: null },
      ],
    }),
  ]);
  try {
    const summary = await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
    assertEqual([summary.created, summary.updated], [0, 1], "recognised as an update");
    assertEqual(summary.lostPoms, [], "nothing was dropped");

    const after = readOnly(dir);
    assertEqual(after.parsed.title, "User signs in with valid credentials", "Qase wins on title");
    assertEqual(after.parsed.steps?.[1].action, "Type the credentials", "Qase wins on steps");
    assertEqual(after.parsed.conductor?.flow, "flows/cases/login.yaml", "flow link survived");
    assertEqual(after.parsed.steps?.[0].pom, "pages/login/open.yaml", "pom survived");
    assertEqual(after.parsed.steps?.[0].env, { path: "login" }, "step env survived");
    assertEqual(after.file, "DEMO-12-user-signs-in-with-valid-credentials.yaml", "file renamed");
  } finally {
    fake.restore();
  }
});

qase.test("reports a page object it could not re-attach instead of dropping it", async () => {
  const dir = store();
  let fake = fakeQase([entity()]);
  try {
    await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
  } finally {
    fake.restore();
  }
  const abs = path.join(dir, readOnly(dir).file);
  writeFileSync(
    abs,
    `${readFileSync(abs, "utf8")}conductor:\n  steps:\n    - {}\n    - pom: pages/login/submit.yaml\n`,
    "utf8",
  );

  // The second step is deleted in Qase, so its page object has nowhere to go.
  fake = fakeQase([
    entity({
      steps: [{ hash: "s1", action: "Open the login screen", data: null, expected_result: "Email is focused" }],
    }),
  ]);
  try {
    const summary = await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
    assertEqual(summary.lostPoms.length, 1, "one orphaned page object");
    assertEqual(summary.lostPoms[0].pom, "pages/login/submit.yaml", "names the page object");
    assertEqual(summary.lostPoms[0].ref, "DEMO-12", "names the case");
  } finally {
    fake.restore();
  }
});

qase.test("a case Qase no longer returns is deprecated, never deleted", async () => {
  const dir = store();
  let fake = fakeQase([entity({ id: 12 }), entity({ id: 13, title: "Second case" })]);
  try {
    await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
  } finally {
    fake.restore();
  }
  assertEqual(readdirSync(dir).filter((f) => f.endsWith(".yaml")).length, 2, "two cases pulled");

  fake = fakeQase([entity({ id: 12 })]);
  try {
    const summary = await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
    assertEqual(summary.deprecated, ["DEMO-13"], "the missing case is reported");
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    assertEqual(files.length, 2, "the file is kept — deleting it would take its flow link");
    const gone = files.find((f) => f.startsWith("DEMO-13"))!;
    const parsed = parseYaml(readFileSync(path.join(dir, gone), "utf8")) as Record<string, unknown>;
    assertEqual(parsed.status, "deprecated", "marked deprecated");
  } finally {
    fake.restore();
  }
});

qase.test("an unknown enum value is left off rather than guessed", async () => {
  const dir = store();
  const fake = fakeQase([entity({ severity: 99 })]);
  try {
    await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
    const { parsed, text } = readOnly(dir);
    assertEqual(parsed.severity, undefined, "no severity invented");
    assert(!text.includes("severity:"), "the key is absent, not wrong");
  } finally {
    fake.restore();
  }
});
