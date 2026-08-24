import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { datasourceKey } from "../electron/services/cases/model";
import { adoptFlatStore, adoptLegacyDir } from "../electron/services/util/legacyStore";
import { assert, assertEqual, TestSuite } from "./runner";

export const projects = new TestSuite("Case sub-projects");

function flatStore(files: string[]): string {
  const base = mkdtempSync(path.join(tmpdir(), "conductor-store-"));
  for (const file of files) writeFileSync(path.join(base, file), "id: 1\n", "utf8");
  return base;
}

projects.test("adopts a pre-sub-project store into the project that inherits it", () => {
  const base = flatStore(["DEMO-1-login.yaml", "DEMO-2-logout.yaml", "results.jsonl"]);
  // The target nests sub-project and datasource, neither of which exists yet.
  adoptFlatStore(base, path.join(base, "default", "qase-demo"));

  assertEqual(readdirSync(path.join(base, "default", "qase-demo")).sort(), [
    "DEMO-1-login.yaml",
    "DEMO-2-logout.yaml",
    "results.jsonl",
  ], "cases and their results moved together");
  assertEqual(readdirSync(base), ["default"], "nothing left loose in the store root");
});

projects.test("mirrored and hand-written cases never share a store", () => {
  assertEqual(datasourceKey({ mode: "qase", projectCode: "MC" }), "qase", "mirrored cases");
  assertEqual(datasourceKey({ mode: "local", projectCode: "TC" }), "local", "hand-written cases");
  // Which Qase project a sub-project mirrors is its business; the store only
  // has to keep pulled cases away from authored ones. Renaming a code, or a
  // local prefix, therefore keeps the cases already there.
  assertEqual(
    datasourceKey({ mode: "qase", projectCode: "TV" }),
    datasourceKey({ mode: "qase", projectCode: "MC" }),
    "a repointed Qase datasource keeps its store",
  );
});

projects.test("a second sub-project never takes files another already adopted", () => {
  const base = flatStore(["DEMO-1-login.yaml"]);
  adoptFlatStore(base, path.join(base, "default"));
  adoptFlatStore(base, path.join(base, "tv"));

  assert(!existsSync(path.join(base, "tv")), "the tv project starts empty");
  assertEqual(readdirSync(path.join(base, "default")), ["DEMO-1-login.yaml"], "files stay put");
});

projects.test("re-running the move leaves an already-migrated store alone", () => {
  const base = flatStore([]);
  const dir = path.join(base, "default");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "DEMO-1-login.yaml"), "id: 1\n", "utf8");
  writeFileSync(path.join(base, "DEMO-9-stray.yaml"), "id: 9\n", "utf8");

  adoptFlatStore(base, dir);

  assertEqual(readdirSync(dir), ["DEMO-1-login.yaml"], "the migrated directory is untouched");
  assert(existsSync(path.join(base, "DEMO-9-stray.yaml")), "a later stray file is not swept in");
});

projects.test("a fresh install has nothing to move", () => {
  const base = flatStore([]);
  adoptFlatStore(base, path.join(base, "default"));
  assertEqual(readdirSync(base), [], "no directory is created for an empty store");
});

projects.test("moves a store written under the old repo-second layout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "conductor-studio-"));
  const legacy = path.join(root, "cases", "app-1f4k2z");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "DEMO-1-login.yaml"), "id: 1\n", "utf8");

  adoptLegacyDir(legacy, path.join(root, "app-1f4k2z", "cases"));

  assertEqual(
    readdirSync(path.join(root, "app-1f4k2z", "cases")),
    ["DEMO-1-login.yaml"],
    "the cases moved under the project",
  );
  assert(!existsSync(path.join(root, "cases")), "the emptied store directory is gone");
});

projects.test("leaves another project's data under a shared old store", () => {
  const root = mkdtempSync(path.join(tmpdir(), "conductor-studio-"));
  const mine = path.join(root, "cases", "app-1f4k2z");
  const theirs = path.join(root, "cases", "other-9z8x7y");
  mkdirSync(mine, { recursive: true });
  mkdirSync(theirs, { recursive: true });

  adoptLegacyDir(mine, path.join(root, "app-1f4k2z", "cases"));

  assert(existsSync(theirs), "a project that has not been opened yet keeps its data");
  assert(existsSync(path.join(root, "app-1f4k2z", "cases")), "mine still moved");
});
