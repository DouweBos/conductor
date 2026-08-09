import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { Tabs, type TabItem } from "./Tabs";

const meta: Meta<typeof Tabs> = {
  title: "Layout/Tabs",
  component: Tabs,
};
export default meta;

const items: TabItem[] = [
  { id: "login.yaml", label: "login.yaml", icon: "file", dirty: true },
  { id: "checkout.yaml", label: "checkout.yaml", icon: "file" },
  { id: "helpers.js", label: "helpers.js", icon: "code" },
];

export const Default: StoryObj<typeof Tabs> = {
  render: () => {
    const [active, setActive] = useState("login.yaml");
    const [tabs, setTabs] = useState(items);
    return (
      <Tabs
        tabs={tabs}
        activeId={active}
        onSelect={setActive}
        onClose={(id) => setTabs((t) => t.filter((x) => x.id !== id))}
      />
    );
  },
};
