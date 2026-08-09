import type { Meta, StoryObj } from "@storybook/react";

import { TextField } from "./TextField";

const meta: Meta<typeof TextField> = {
  title: "Controls/TextField",
  component: TextField,
};
export default meta;

export const Default: StoryObj<typeof TextField> = {
  args: { placeholder: "Search flows…", icon: "search" },
};

export const WithLabel: StoryObj<typeof TextField> = {
  args: { label: "Flow name", placeholder: "login.yaml", id: "flow-name" },
};
