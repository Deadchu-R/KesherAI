import { agent } from "@agentclientprotocol/sdk";

/** A fake agent: one sign-in method; a prompt streams a thought, asks to edit a file, and answers. */
export function fakeAgent(seen: { auth?: string; cancelled?: boolean; caps?: unknown }) {
  return agent()
    .onRequest("initialize", ({ params }) => {
      seen.caps = params.clientCapabilities;
      return { protocolVersion: 1, agentInfo: { name: "fake-agy", version: "1.5.4" }, authMethods: [{ id: "oauth-personal", name: "Log in with Google" }], agentCapabilities: { loadSession: true } };
    })
    .onRequest("authenticate", ({ params }) => {
      seen.auth = params.methodId;
      return {};
    })
    .onRequest("session/new", () => ({ sessionId: "s1" }))
    .onNotification("session/cancel", () => {
      seen.cancelled = true;
    })
    .onRequest("session/prompt", async ({ params, client }) => {
      const sessionId = params.sessionId;
      await client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } });
      await client.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit a.ts", kind: "edit", status: "pending" } });
      const r = await client.request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "t1", title: "Edit a.ts", kind: "edit" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Deny", kind: "reject_once" },
        ],
      });
      const ok = r.outcome.outcome === "selected" && r.outcome.optionId === "yes";
      await client.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: ok ? "completed" : "failed", content: ok ? [{ type: "diff", path: "/p/a.ts", oldText: "a", newText: "b" }] : [] } });
      await client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ok ? "Done." : "Skipped." } } });
      return { stopReason: "end_turn" };
    });
}

