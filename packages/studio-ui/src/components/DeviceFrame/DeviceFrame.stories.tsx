import type { Meta, StoryObj } from "@storybook/react";

import { EmptyState } from "../EmptyState/EmptyState";
import { DeviceFrame } from "./DeviceFrame";

const meta: Meta<typeof DeviceFrame> = {
  title: "Device/DeviceFrame",
  component: DeviceFrame,
};
export default meta;

export const Empty: StoryObj<typeof DeviceFrame> = {
  render: () => (
    <div style={{ height: 480 }}>
      <DeviceFrame label="iPhone 15 · 1179×2556">
        <EmptyState icon="device" title="No device connected" />
      </DeviceFrame>
    </div>
  ),
};
