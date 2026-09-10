import { useEffect } from "react";

import { initParityStore } from "../stores/parityStore";

/**
 * Subscribe to parity run progress for the life of the app, not the life of the
 * Parity view — a four-device run takes a while, and leaving the screen to look
 * at a flow shouldn't lose the checkpoints that land while you're away.
 */
export function useParityEvents(): void {
  useEffect(() => initParityStore(), []);
}
