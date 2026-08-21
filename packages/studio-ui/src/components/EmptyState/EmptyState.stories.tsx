import type { Meta, StoryObj } from "@storybook/react";

import { Button } from "../Button/Button";
import { EmptyState } from "./EmptyState";

const meta: Meta<typeof EmptyState> = {
  title: "Feedback/EmptyState",
  component: EmptyState,
};
export default meta;

export const Default: StoryObj<typeof EmptyState> = {
  args: {
    icon: "flow",
    title: "No flow selected",
    description: "Pick a flow from the sidebar or create a new one to get started.",
    action: (
      <Button variant="primary" icon="plus">
        New flow
      </Button>
    ),
  },
};
