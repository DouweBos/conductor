import type { Meta, StoryObj } from "@storybook/react";

import { TreeView, type TreeNode } from "./TreeView";

const meta: Meta<typeof TreeView> = {
  title: "Data/TreeView",
  component: TreeView,
};
export default meta;

const nodes: TreeNode[] = [
  {
    id: "screen",
    label: "Screen",
    icon: "device",
    children: [
      {
        id: "nav",
        label: "NavigationBar",
        icon: "dot",
        children: [{ id: "title", label: "Text “Checkout”", icon: "dot", meta: "@e1" }],
      },
      { id: "cta", label: "Button “Pay now”", icon: "tap", meta: "@e2" },
    ],
  },
];

export const Hierarchy: StoryObj<typeof TreeView> = {
  render: () => <TreeView nodes={nodes} expandAll selectedId="cta" />,
};
