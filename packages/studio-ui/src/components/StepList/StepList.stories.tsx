import type { Meta, StoryObj } from "@storybook/react";

import { StepList } from "./StepList";

const meta: Meta<typeof StepList> = {
  title: "Feedback/StepList",
  component: StepList,
};
export default meta;

export const Default: StoryObj<typeof StepList> = {
  render: () => (
    <StepList
      steps={[
        { id: "1", label: "launchApp", status: "passed" },
        { id: "2", label: 'tapOn: "Login"', status: "passed" },
        { id: "3", label: 'inputText: "user@example.com"', status: "running" },
        { id: "4", label: 'assertVisible: "Welcome"', status: "pending" },
      ]}
    />
  ),
};

export const WithFailure: StoryObj<typeof StepList> = {
  render: () => (
    <StepList
      steps={[
        { id: "1", label: "launchApp", status: "passed" },
        { id: "2", label: 'tapOn: "Pay now"', status: "failed" },
        { id: "3", label: 'assertVisible: "Order confirmed"', status: "pending" },
      ]}
    />
  ),
};
