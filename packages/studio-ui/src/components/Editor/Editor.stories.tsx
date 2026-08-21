import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { Editor } from "./Editor";

const meta: Meta<typeof Editor> = {
  title: "Editor/Editor",
  component: Editor,
};
export default meta;

const SAMPLE = `appId: com.example.app
---
- launchApp
- tapOn: "Login"
- inputText: "user@example.com"
- tapOn: "Continue"
- assertVisible: "Welcome"
`;

export const Yaml: StoryObj<typeof Editor> = {
  render: () => {
    const [value, setValue] = useState(SAMPLE);
    return (
      <div style={{ height: 300, border: "1px solid var(--border)" }}>
        <Editor value={value} onChange={setValue} language="yaml" />
      </div>
    );
  },
};
