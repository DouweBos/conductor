import { useEffect, useRef } from "react";

import { listen } from "../lib/events";

/**
 * Subscribe to a backend push channel for the lifetime of the component. The
 * handler is kept in a ref so callers don't have to memoize it, and the
 * subscription re-binds only when the channel changes.
 */
export function useIpcEvent<T = unknown>(
  channel: string | null,
  handler: (payload: T) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!channel) return;
    const unlisten = listen<T>(channel, (payload) => handlerRef.current(payload));
    return unlisten;
  }, [channel]);
}
