import type { Meta, StoryObj } from "@storybook/react";

import { IconButton } from "./IconButton";

const meta: Meta<typeof IconButton> = {
  title: "Controls/IconButton",
  component: IconButton,
  args: { icon: "refresh", label: "Refresh" },
};
export default meta;

type Story = StoryObj<typeof IconButton>;

export const Default: Story = {};
export const Active: Story = { args: { icon: "device", label: "Device", active: true } };
