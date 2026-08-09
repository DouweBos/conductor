import type { Meta, StoryObj } from "@storybook/react";

import { ToastViewport } from "./Toast";

const meta: Meta<typeof ToastViewport> = {
  title: "Feedback/Toast",
  component: ToastViewport,
};
export default meta;

export const Default: StoryObj<typeof ToastViewport> = {
  render: () => (
    <ToastViewport
      onDismiss={() => {}}
      toasts={[
        { id: "1", tone: "success", title: "Flow passed", message: "checkout.yaml — 8 steps" },
        { id: "2", tone: "error", title: "Flow failed", message: "assertVisible “Welcome” timed out" },
      ]}
    />
  ),
};
