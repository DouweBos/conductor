import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { Button } from "../Button/Button";
import { Dialog } from "./Dialog";

const meta: Meta<typeof Dialog> = {
  title: "Overlays/Dialog",
  component: Dialog,
};
export default meta;

export const Default: StoryObj<typeof Dialog> = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open dialog</Button>
        <Dialog
          open={open}
          title="New flow"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setOpen(false)}>
                Create
              </Button>
            </>
          }
        >
          Dialog body content goes here.
        </Dialog>
      </>
    );
  },
};
