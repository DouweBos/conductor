import type { Meta, StoryObj } from "@storybook/react";

import { Tag } from "./Tag";

const meta: Meta<typeof Tag> = {
  title: "Data/Tag",
  component: Tag,
};
export default meta;

export const Default: StoryObj<typeof Tag> = {
  render: () => (
    <div style={{ display: "flex", gap: 6 }}>
      <Tag>ios</Tag>
      <Tag>checkout</Tag>
      <Tag onRemove={() => {}}>fintech</Tag>
    </div>
  ),
};
