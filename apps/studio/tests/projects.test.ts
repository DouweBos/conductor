import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { adoptLegacyDir } from "../electron/services/util/legacyStore";
import { assert, assertEqual, TestSuite } from "./runner";

export const projects = new TestSuite("Studio store layout");

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
