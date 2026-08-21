import { Button, Spinner, StatusPill } from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import { useIpcEvent } from "../../hooks/useIpcEvent";
import { getUpdaterState, updaterDownload, updaterInstall } from "../../lib/ipc";
import type { UpdaterState } from "../../lib/types";

export function UpdaterBadge() {
  const [state, setState] = useState<UpdaterState>({ phase: "idle" });

  useEffect(() => {
    getUpdaterState().then(setState).catch(() => {});
  }, []);
  useIpcEvent<UpdaterState>("updater:state", setState);

  switch (state.phase) {
    case "available":
      return (
        <Button size="sm" variant="primary" icon="refresh" onClick={() => void updaterDownload()}>
          Update {state.version}
        </Button>
      );
    case "downloading":
      return <Spinner size={14} label={`Downloading ${state.progress ?? 0}%`} />;
    case "downloaded":
      return (
        <Button size="sm" variant="primary" icon="refresh" onClick={() => void updaterInstall()}>
          Restart to update
        </Button>
      );
    case "error":
      return <StatusPill tone="error">Update error</StatusPill>;
    default:
      return null;
  }
}
