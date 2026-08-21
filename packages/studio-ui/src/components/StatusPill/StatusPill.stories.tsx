import type { Meta, StoryObj } from "@storybook/react";

import { StatusPill } from "./StatusPill";

const meta: Meta<typeof StatusPill> = {
  title: "Feedback/StatusPill",
  component: StatusPill,
};
export default meta;

export const AllTones: StoryObj<typeof StatusPill> = {
  render: () => (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <StatusPill tone="success">Passed</StatusPill>
      <StatusPill tone="error">Failed</StatusPill>
      <StatusPill tone="warning">Flaky</StatusPill>
      <StatusPill tone="running" pulse>
        Running
      </StatusPill>
      <StatusPill tone="info">Skipped</StatusPill>
      <StatusPill tone="neutral">Not run</StatusPill>
    </div>
  ),
};
