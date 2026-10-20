import { createFileRoute } from "@tanstack/react-router";

import { handleAssistantChat } from "@/lib/assistant.server";

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: ({ request }) => handleAssistantChat(request),
    },
  },
});
