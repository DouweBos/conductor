import { create } from "zustand";

import { lintProject } from "../lib/ipc";
import type { LintProblem } from "../lib/types";

/** Everything the linter found across the project, refreshed on demand. */
interface ProblemState {
  problems: LintProblem[];
  loading: boolean;
  error: string | null;
}

const store = create<ProblemState>(() => ({ problems: [], loading: false, error: null }));

export const useProblems = () => store((s) => s.problems);
export const useProblemsLoading = () => store((s) => s.loading);

export async function refreshProblems(): Promise<void> {
  store.setState({ loading: true, error: null });
  try {
    store.setState({ problems: await lintProject(), loading: false });
  } catch (err) {
    store.setState({ error: String(err), loading: false, problems: [] });
  }
}
