import type { Meta, StoryObj } from "@storybook/react";

import { FileTree, type FileEntry } from "./FileTree";

const meta: Meta<typeof FileTree> = {
  title: "Data/FileTree",
  component: FileTree,
};
export default meta;

const entries: FileEntry[] = [
  {
    path: "auth",
    name: "auth",
    type: "dir",
    children: [
      { path: "auth/login.yaml", name: "login.yaml", type: "file" },
      { path: "auth/logout.yaml", name: "logout.yaml", type: "file" },
    ],
  },
  { path: "checkout.yaml", name: "checkout.yaml", type: "file" },
  { path: "helpers.js", name: "helpers.js", type: "file" },
];

export const Default: StoryObj<typeof FileTree> = {
  render: () => <FileTree entries={entries} selectedPath="checkout.yaml" />,
};
