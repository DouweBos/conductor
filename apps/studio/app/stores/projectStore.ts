import { create } from "zustand";

import { getProjectInfo, listFlows, openProject } from "../lib/ipc";
import type { FileEntry, ProjectInfo } from "../lib/types";

interface ProjectState {
  project: ProjectInfo | null;
  flows: FileEntry[];
  loading: boolean;
  error: string | null;
}

const store = create<ProjectState>(() => ({
  project: null,
  flows: [],
  loading: false,
  error: null,
}));

export const useProject = () => store((s) => s.project);
export const useFlows = () => store((s) => s.flows);
export const useProjectLoading = () => store((s) => s.loading);
export const useProjectError = () => store((s) => s.error);

export async function initProject(): Promise<void> {
  store.setState({ loading: true });
  try {
    let project = await getProjectInfo();
    if (!project) project = await openProject();
    store.setState({ project });
    await refreshFlows();
  } catch (err) {
    store.setState({ error: String(err) });
  } finally {
    store.setState({ loading: false });
  }
}

export async function openProjectAt(root: string): Promise<void> {
  store.setState({ loading: true, error: null });
  try {
    const project = await openProject(root);
    store.setState({ project });
    await refreshFlows();
  } catch (err) {
    store.setState({ error: String(err) });
  } finally {
    store.setState({ loading: false });
  }
}

export async function refreshFlows(): Promise<void> {
  try {
    const flows = await listFlows();
    store.setState({ flows });
  } catch (err) {
    store.setState({ error: String(err) });
  }
}
