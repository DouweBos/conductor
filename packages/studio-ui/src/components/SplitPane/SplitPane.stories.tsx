import type { Meta, StoryObj } from "@storybook/react";

import { Panel } from "../Panel/Panel";
import { SplitPane } from "./SplitPane";

const meta: Meta<typeof SplitPane> = {
  title: "Layout/SplitPane",
  component: SplitPane,
};
export default meta;

type Story = StoryObj<typeof SplitPane>;

export const ThreeColumn: Story = {
  render: () => (
    <div style={{ height: 320, border: "1px solid var(--border)" }}>
      <SplitPane initialSizes={[180, 260]}>
        <Panel title="Flows">Left</Panel>
        <Panel title="Editor">Center</Panel>
        <Panel title="Device">Right</Panel>
      </SplitPane>
    </div>
  ),
};
