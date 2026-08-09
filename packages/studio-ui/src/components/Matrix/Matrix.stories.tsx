import type { Meta, StoryObj } from "@storybook/react";

import { StatusPill } from "../StatusPill/StatusPill";
import { Matrix } from "./Matrix";

const meta: Meta<typeof Matrix> = {
  title: "Data/Matrix",
  component: Matrix,
};
export default meta;

export const Default: StoryObj<typeof Matrix> = {
  render: () => (
    <div style={{ height: 260, border: "1px solid var(--border)" }}>
      <Matrix
        columns={[
          { id: "ios", label: "iOS" },
          { id: "android", label: "Android" },
          { id: "web", label: "Web" },
        ]}
        rows={[
          {
            id: "login",
            label: "User can log in",
            sublabel: "auth/login.yaml",
            cells: {
              ios: <StatusPill tone="success">Pass</StatusPill>,
              android: <StatusPill tone="error">Fail</StatusPill>,
              web: <StatusPill tone="neutral">Not run</StatusPill>,
            },
          },
          {
            id: "checkout",
            label: "User can check out",
            sublabel: "checkout.yaml",
            cells: {
              ios: <StatusPill tone="success">Pass</StatusPill>,
              android: <StatusPill tone="success">Pass</StatusPill>,
            },
          },
        ]}
      />
    </div>
  ),
};
