import { z } from "zod";

/** Who wrote a chat message. Mirrors the OpenAI and Anthropic roles. */
export const ChatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

/** Who wrote a chat message; see {@link ChatRoleSchema}. */
export type ChatRole = z.infer<typeof ChatRoleSchema>;

/** One message in a conversation. Content is plain text in this version. */
export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string(),
  /** For `tool` messages: the id of the tool call this answers. */
  toolCallId: z.string().optional(),
});

/** One message in a conversation; see {@link ChatMessageSchema}. */
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** Body of `POST /api/chat`. */
export const ChatRequestSchema = z.object({
  /** Global model id, e.g. `lmstudio/qwen3-14b`. */
  modelId: z.string(),
  messages: z.array(ChatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});

/** Body of `POST /api/chat`; see {@link ChatRequestSchema}. */
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/**
 * One event in a streamed chat response. The core server sends these as
 * Server-Sent Events, one JSON object per `data:` line.
 */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: "error"; message: string };
