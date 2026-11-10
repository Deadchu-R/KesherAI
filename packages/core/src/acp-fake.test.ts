import { agent } from "@agentclientprotocol/sdk";

/** A fake agent: one sign-in method; a prompt streams a thought, asks to edit a file, and answers. */
export function fakeAgent(seen: { auth?: string; cancelled?: boolean; caps?: unknown; mode?: string; option?: string }) {
  return agent()
    .onRequest("initialize", ({ params }) => {
      seen.caps = params.clientCapabilities;
      return { protocolVersion: 1, agentInfo: { name: "fake-agy", version: "1.5.4" }, authMethods: [{ id: "oauth-personal", name: "Log in with Google" }], agentCapabilities: { loadSession: true } };
    })
    .onRequest("authenticate", ({ params }) => {
      seen.auth = params.methodId;
      return {};
    })
    .onRequest("session/set_config_option", ({ params }) => {
      seen.option = `${params.configId}=${String(params.value)}`;
      return { configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: String(params.value), options: [{ value: "gemini-4-pro", name: "Gemini 4 Pro" }, { value: "gemini-4-flash", name: "Gemini 4 Flash" }] }] };
    })
    .onRequest("session/new", () => ({ sessionId: "s1", configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-4-pro", options: [{ group: "g", name: "Google", options: [{ value: "gemini-4-pro", name: "Gemini 4 Pro" }, { value: "gemini-4-flash", name: "Gemini 4 Flash" }] }] }, { id: "fast", name: "Fast", type: "boolean", currentValue: false }], modes: { currentModeId: "accept-edits", availableModes: [{ id: "default", name: "Default" }, { id: "accept-edits", name: "Accept edits" }, { id: "plan", name: "Plan" }] } }))
    .onRequest("session/set_mode", ({ params }) => {
      seen.mode = params.modeId;
      return {};
    })
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

