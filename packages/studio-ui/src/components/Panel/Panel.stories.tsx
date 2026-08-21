import type { Meta, StoryObj } from "@storybook/react";

import { IconButton } from "../IconButton/IconButton";
import { Panel } from "./Panel";

const meta: Meta<typeof Panel> = {
  title: "Layout/Panel",
  component: Panel,
};
export default meta;

type Story = StoryObj<typeof Panel>;

export const Default: Story = {
  render: () => (
    <div style={{ height: 240, width: 320 }}>
      <Panel
        title="Flows"
        actions={<IconButton icon="plus" label="New flow" />}
      >
        Panel body content.
      </Panel>
    </div>
  ),
};
