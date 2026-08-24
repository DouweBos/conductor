import path from "node:path";

import { getProjectInfo } from "../file/fileService";
import {
  getActiveCaseProject,
  getCaseProjects,
  getQaseToken,
  LEGACY_PROJECT,
} from "../settings/settingsService";
import { adoptFlatStore } from "../util/legacyStore";
import { studioDir } from "../util/studioPaths";
import { ALL_PROJECTS, datasourceKey, type CaseProject, type CasesDatasource } from "./model";

/**
 * Sub-projects: one repo, several apps. A monorepo with a mobile app and a tv
 * app mirrors two Qase projects, and everything the Cases screen owns — cases,
 * plans, results — is scoped to one of them. `all` merges them for reading;
 * writing needs a single target, since a new case has to land somewhere.
 */

export function repoRoot(): string {
  const info = getProjectInfo();
  if (!info) throw new Error("No project is open.");
  return info.root;
}

export function caseProjects(): CaseProject[] {
  return getCaseProjects(repoRoot());
}

export function activeProjectId(): string {
  return getActiveCaseProject(repoRoot());
}

/** The sub-projects the current selection covers — every one under `all`. */
export function selectedProjects(): CaseProject[] {
  const projects = caseProjects();
  const active = activeProjectId();
  if (active === ALL_PROJECTS) return projects;
  return projects.filter((p) => p.id === active);
}

/**
 * The one sub-project to write to. `all` is a reading view: a case, plan or
 * pull has to name its project, and guessing would put it in the wrong app.
 */
export function targetProject(): CaseProject {
  const active = activeProjectId();
  if (active === ALL_PROJECTS) {
    throw new Error("Choose a project first — “All projects” is read-only.");
  }
  const found = caseProjects().find((p) => p.id === active);
  if (!found) throw new Error("The selected project no longer exists.");
  return found;
}

export function datasourceOf(projectId: string): CasesDatasource {
  const found = caseProjects().find((p) => p.id === projectId);
  if (!found) throw new Error(`No case project "${projectId}".`);
  return found.datasource;
}

export function tokenFor(projectId: string): string | undefined {
  return getQaseToken(repoRoot(), projectId);
}

/**
 * Where one sub-project's `cases` or `plans` live: `<sub-project>/<datasource>`.
 * Splitting by datasource is what keeps a Qase mirror and hand-written cases
 * apart, and one Qase project's cases out of another's — switching a
 * datasource switches stores rather than pouring one into the other.
 *
 * Pre-sub-project installs kept everything flat in the store root; the first
 * read after upgrading moves it under the sub-project and datasource that
 * inherited it, so nothing has to be re-pulled.
 */
export function caseProjectDir(store: "cases" | "plans", projectId: string): string {
  const base = studioDir(store, repoRoot());
  const project = caseProjects().find((p) => p.id === projectId);
  const dir = path.join(base, projectId, datasourceKey(project?.datasource ?? { mode: "local", projectCode: "" }));
  // Only the sub-project that inherited the old single-project setup claims them.
  if (projectId === LEGACY_PROJECT) adoptFlatStore(base, dir);
  return dir;
}
