import type { Meta, StoryObj } from "@storybook/react";

import { Button } from "../Button/Button";
import { IconButton } from "../IconButton/IconButton";
import { Toolbar, ToolbarDivider, ToolbarSpacer } from "./Toolbar";

const meta: Meta<typeof Toolbar> = {
  title: "Layout/Toolbar",
  component: Toolbar,
};
export default meta;

type Story = StoryObj<typeof Toolbar>;

export const Default: Story = {
  render: () => (
    <Toolbar>
      <Button variant="primary" size="sm" icon="play">
        Run
      </Button>
      <IconButton icon="stop" label="Stop" />
      <ToolbarDivider />
      <IconButton icon="refresh" label="Reload" />
      <ToolbarSpacer />
      <IconButton icon="settings" label="Settings" />
    </Toolbar>
  ),
};
