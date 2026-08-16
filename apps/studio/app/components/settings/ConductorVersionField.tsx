/**
 * Settings → Conductor version. Lets the user pin a conductor version that
 * Studio installs at runtime — no app update required. The picker lists npm
 * releases at or above the bundled one; "Bundled" reverts to the version
 * shipped with the app.
 *
 * Main owns provisioning; this reads status, pushes a version, and reflects
 * install progress pushed back over `conductor_status_changed`.
 */

import { Select, Spinner } from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import { useIpcEvent } from "../../hooks/useIpcEvent";
import { getConductorStatus, listConductorVersions, setConductorVersion } from "../../lib/ipc";
import type { ConductorStatus } from "../../lib/types";
import styles from "./SettingsDialog.module.css";

const STATUS_EVENT = "conductor_status_changed";

export function ConductorVersionField() {
  const [status, setStatus] = useState<ConductorStatus | null>(null);
  const [versions, setVersions] = useState<string[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getConductorStatus()
      .then((s) => active && setStatus(s))
      .catch(() => {});
    listConductorVersions().then(
      (v) => active && setVersions(v),
      (e: unknown) => active && setListError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      active = false;
    };
  }, []);

  useIpcEvent<ConductorStatus>(STATUS_EVENT, setStatus);

  const installing = status?.state === "installing";
  const pinned = status?.overrideVersion ?? "";
  // A pinned version that predates this build won't be in the fetched list —
  // keep it selectable so the dropdown still reflects reality.
  const listed = pinned && !versions.includes(pinned) ? [pinned, ...versions] : versions;

  const options = [
    { value: "", label: `Bundled${status?.bundledVersion ? ` (${status.bundledVersion})` : ""}` },
    ...listed.map((v) => ({ value: v, label: v })),
  ];

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor="conductor-version">
        Conductor version
      </label>
      <p className={styles.caption}>
        Pin the conductor CLI version Studio and its agents use. Installed on demand from npm — no
        app update needed. Only versions at or above the bundled one are listed.
      </p>
      <Select
        id="conductor-version"
        disabled={installing || (listed.length === 0 && !pinned)}
        options={options}
        value={pinned}
        onChange={(e) => {
          void setConductorVersion(e.target.value || null).then(setStatus);
        }}
      />
      <StatusLine listError={listError} status={status} />
    </div>
  );
}

function StatusLine({
  listError,
  status,
}: {
  listError: string | null;
  status: ConductorStatus | null;
}) {
  if (!status) return null;

  if (status.state === "installing") {
    return (
      <p className={styles.status}>
        <Spinner size={12} /> Installing conductor v{status.overrideVersion}…
      </p>
    );
  }
  if (status.state === "error") {
    return (
      <p className={`${styles.status} ${styles.error}`}>
        {status.error ?? "Install failed."} Using bundled v{status.bundledVersion}.
      </p>
    );
  }
  if (listError) {
    return <p className={`${styles.status} ${styles.error}`}>{listError}</p>;
  }
  if (status.overrideVersion && status.state === "ready") {
    return <p className={styles.status}>Using pinned conductor v{status.activeVersion}.</p>;
  }
  return (
    <p className={styles.status}>
      Using bundled conductor v{status.bundledVersion ?? "unknown"}.
    </p>
  );
}
