import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { SegmentedControl } from "./SegmentedControl";

const meta: Meta<typeof SegmentedControl> = {
  title: "Components/SegmentedControl",
  component: SegmentedControl,
};
export default meta;

export const Modes: StoryObj<typeof SegmentedControl> = {
  render: () => {
    const [value, setValue] = useState("interact");
    return (
      <SegmentedControl
        label="Device mode"
        options={[
          { value: "interact", label: "Interact" },
          { value: "inspect", label: "Inspect" },
        ]}
        value={value}
        onChange={setValue}
      />
    );
  },
};
