import type { Meta, StoryObj } from "@storybook/react";

import { ChatMessage } from "./ChatMessage";

const meta: Meta<typeof ChatMessage> = {
  title: "Agent/ChatMessage",
  component: ChatMessage,
};
export default meta;

export const Conversation: StoryObj<typeof ChatMessage> = {
  render: () => (
    <div style={{ maxWidth: 520 }}>
      <ChatMessage role="user">Write a login test for the app.</ChatMessage>
      <ChatMessage role="assistant">
        I'll capture the current screen first, then tap the login button.
      </ChatMessage>
    </div>
  ),
};
