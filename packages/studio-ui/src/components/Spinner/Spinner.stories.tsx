import type { Meta, StoryObj } from "@storybook/react";

import { Spinner } from "./Spinner";

const meta: Meta<typeof Spinner> = {
  title: "Feedback/Spinner",
  component: Spinner,
};
export default meta;

export const Default: StoryObj<typeof Spinner> = {
  args: { size: 20, label: "Booting device…" },
};
