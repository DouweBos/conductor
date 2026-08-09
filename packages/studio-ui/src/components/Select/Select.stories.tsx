import type { Meta, StoryObj } from "@storybook/react";

import { Select } from "./Select";

const meta: Meta<typeof Select> = {
  title: "Controls/Select",
  component: Select,
};
export default meta;

export const Default: StoryObj<typeof Select> = {
  args: {
    placeholder: "Choose a device…",
    options: [
      { value: "iphone15", label: "iPhone 15 (booted)" },
      { value: "iphone15pro", label: "iPhone 15 Pro" },
      { value: "pixel8", label: "Pixel 8 (emulator)" },
    ],
  },
};
