import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { Button } from "../Button/Button";
import { ContextMenu } from "./ContextMenu";

const meta: Meta<typeof ContextMenu> = {
  title: "Overlays/ContextMenu",
  component: ContextMenu,
};
export default meta;

export const Default: StoryObj<typeof ContextMenu> = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open menu</Button>
        <ContextMenu
          open={open}
          x={80}
          y={80}
          onClose={() => setOpen(false)}
          items={[
            { label: "Rename", icon: "file", onClick: () => {} },
            { label: "Duplicate", icon: "plus", onClick: () => {} },
            { label: "New folder", icon: "folder", onClick: () => {} },
            { label: "Delete", icon: "close", danger: true, onClick: () => {} },
          ]}
        />
      </>
    );
  },
};
