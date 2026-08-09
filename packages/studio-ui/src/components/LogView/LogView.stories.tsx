import type { Meta, StoryObj } from "@storybook/react";

import { LogView } from "./LogView";

const meta: Meta<typeof LogView> = {
  title: "Feedback/LogView",
  component: LogView,
};
export default meta;

export const Default: StoryObj<typeof LogView> = {
  render: () => (
    <div style={{ height: 200, border: "1px solid var(--border)" }}>
      <LogView
        lines={[
          { id: "1", tone: "command", text: "$ maestro test checkout.yaml" },
          { id: "2", text: "Running on iPhone 15 (booted)" },
          { id: "3", tone: "success", text: "✓ launchApp" },
          { id: "4", tone: "success", text: "✓ tapOn: Pay now" },
          { id: "5", tone: "error", text: "✗ assertVisible: Order confirmed (timed out)" },
        ]}
      />
    </div>
  ),
};
