import type { Meta, StoryObj } from "@storybook/react";

import { Button } from "./Button";

const meta: Meta<typeof Button> = {
  title: "Controls/Button",
  component: Button,
  args: { children: "Run flow" },
};
export default meta;

type Story = StoryObj<typeof Button>;

export const Primary: Story = { args: { variant: "primary", icon: "play" } };
export const Secondary: Story = { args: { variant: "secondary" } };
export const Ghost: Story = { args: { variant: "ghost", icon: "refresh" } };
export const Danger: Story = { args: { variant: "danger", children: "Clear state" } };
export const Small: Story = { args: { size: "sm", variant: "primary", icon: "play" } };

export const Row: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 8 }}>
      <Button variant="primary" icon="play">
        Run
      </Button>
      <Button variant="secondary" icon="stop">
        Stop
      </Button>
      <Button variant="ghost" icon="refresh" />
    </div>
  ),
};
