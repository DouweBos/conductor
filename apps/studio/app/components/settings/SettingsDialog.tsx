import { Dialog } from "@conductor/studio-ui";

import { ConductorVersionField } from "./ConductorVersionField";

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} title="Settings" onClose={onClose} width={520}>
      <ConductorVersionField />
    </Dialog>
  );
}
