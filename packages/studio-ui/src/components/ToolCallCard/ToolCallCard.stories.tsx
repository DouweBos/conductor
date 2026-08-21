import type { Meta, StoryObj } from "@storybook/react";

import { ToolCallCard } from "./ToolCallCard";

const meta: Meta<typeof ToolCallCard> = {
  title: "Agent/ToolCallCard",
  component: ToolCallCard,
};
export default meta;

export const Default: StoryObj<typeof ToolCallCard> = {
  render: () => (
    <div style={{ maxWidth: 520 }}>
      <ToolCallCard
        name="Bash"
        summary="conductor capture-ui --device iphone15 --json"
        state="done"
        detail={'{"cmd":"capture-ui","device":"iphone15"}'}
      />
      <ToolCallCard name="Write" summary=".maestro/login.yaml" state="done" />
      <ToolCallCard name="Bash" summary="conductor tap-on Login" state="pending" />
    </div>
  ),
};
