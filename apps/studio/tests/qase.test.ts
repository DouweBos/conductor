import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { parseCase } from "../electron/services/cases/caseFile";
import { listProjects } from "../electron/services/cases/qaseClient";
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

qase.test("lists every project the token can see, across pages", async () => {
  const all = Array.from({ length: 120 }, (_, i) => ({ code: `P${i + 1}`, title: `Project ${i + 1}` }));
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const params = new URL(String(url)).searchParams;
    const offset = Number(params.get("offset") ?? 0);
    const limit = Number(params.get("limit") ?? 100);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        result: { total: all.length, entities: all.slice(offset, offset + limit) },
      }),
    };
  }) as typeof fetch;

  try {
    const projects = await listProjects("t");
    assertEqual(projects.length, 120, "every page returned");
    assertEqual(projects[119].code, "P120", "last project present");
  } finally {
    globalThis.fetch = original;
  }
});

// Each datasource has its own store, so this only arises in a pre-sub-project
// store that a repointed datasource left mixed — where it wiped out a project.
qase.test("a pull never deprecates cases another Qase project put in the store", async () => {
  const dir = store();

  // A first project's cases are pulled into the store.
  let fake = fakeQase(Array.from({ length: 3 }, (_, i) => entity({ id: i + 1 })));
  try {
    await pullCases({ casesDir: dir, projectCode: "MC", token: "t" });
  } finally {
    fake.restore();
  }
  assertEqual(readdirSync(dir).length, 3, "three cases from the first project");

  // The datasource is repointed at another project, which shares case ids.
  fake = fakeQase([entity({ id: 1, title: "A TV case" })]);
  let summary;
  try {
    summary = await pullCases({ casesDir: dir, projectCode: "TV", token: "t" });
  } finally {
    fake.restore();
  }

  assertEqual(summary.deprecated, [], "the other project's cases are not 'missing from Qase'");
  assertEqual(summary.foreign, 3, "they are reported as another project's, and skipped");
  assertEqual(summary.created, 1, "the new project's case is written alongside them");

  const files = readdirSync(dir).sort();
  assertEqual(files.length, 4, "nothing was overwritten despite the shared id");
  assert(files.some((f) => f.startsWith("MC-1-")), "MC-1 still exists");
  assert(files.some((f) => f.startsWith("TV-1-")), "TV-1 was created beside it");

  const mcFile = path.join(dir, files.find((f) => f.startsWith("MC-1-"))!);
  const untouched = parseCase(
    parseYaml(readFileSync(mcFile, "utf8")) as Record<string, unknown>,
    mcFile,
    "MC",
  )!;
  assertEqual(untouched.status, "actual", "still actual, not deprecated");
  assertEqual(untouched.title, entity().title, "and still holds its own project's content");
});

qase.test("a second sync of unchanged cases updates nothing", async () => {
  const dir = store();
  let fake = fakeQase([entity(), entity({ id: 13, title: "Second case" })]);
  try {
    const first = await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
    assertEqual([first.created, first.updated, first.unchanged], [2, 0, 0], "first pull writes both");
  } finally {
    fake.restore();
  }

  const before = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => readFileSync(path.join(dir, f), "utf8"));

  fake = fakeQase([entity(), entity({ id: 13, title: "Second case" })]);
  let second;
  try {
    second = await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
  } finally {
    fake.restore();
  }

  assertEqual([second.pulled, second.created, second.updated], [2, 0, 0], "nothing counted as changed");
  assertEqual(second.unchanged, 2, "both are reported as unchanged");
  assertEqual(
    readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => readFileSync(path.join(dir, f), "utf8")),
    before,
    "and the files are byte-identical",
  );
});

qase.test("a case Qase actually edited still counts as updated", async () => {
  const dir = store();
  let fake = fakeQase([entity(), entity({ id: 13, title: "Second case" })]);
  try {
    await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
  } finally {
    fake.restore();
  }

  fake = fakeQase([entity({ priority: 1 }), entity({ id: 13, title: "Second case" })]);
  let summary;
  try {
    summary = await pullCases({ casesDir: dir, projectCode: PROJECT, token: "t" });
  } finally {
    fake.restore();
  }

  assertEqual([summary.updated, summary.unchanged], [1, 1], "only the edited case is updated");
  const file = readdirSync(dir).find((f) => f.startsWith("DEMO-12-"))!;
  const edited = parseCase(
    parseYaml(readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>,
    path.join(dir, file),
    PROJECT,
  )!;
  assertEqual(edited.priority, "high", "Qase's edit landed in the file");
});
