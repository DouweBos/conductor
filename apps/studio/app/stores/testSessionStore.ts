import { create } from "zustand";

import { currentTestSession, clearTestSession as clearOnDisk } from "../lib/ipc";
import type { TestSession } from "../lib/types";

/** The test running right now, pushed from the main process as it progresses. */
interface State {
  session: TestSession | null;
}

const store = create<State>(() => ({ session: null }));

export const useTestSession = () => store((s) => s.session);

export function setTestSession(session: TestSession | null): void {
  store.setState({ session });
}

export function refreshTestSession(): void {
  void currentTestSession()
    .then((session) => store.setState({ session }))
    .catch(() => store.setState({ session: null }));
}

export function dismissTestSession(): void {
  store.setState({ session: null });
  void clearOnDisk().catch(() => {});
}
