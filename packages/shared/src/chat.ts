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
  /**
   * Local reasoning models: `off` for a short direct answer (router, inline code, titles), `low` or `high` to
   * think less or more; unset leaves the model's default (which may spend the whole budget thinking).
   */
  thinking: z.enum(["off", "low", "high"]).optional(),
});

/** Body of `POST /api/chat`; see {@link ChatRequestSchema}. */
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/**
 * One event in a streamed chat response. The core server sends these as
 * Server-Sent Events, one JSON object per `data:` line.
 */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  /** The model's thinking (llama.cpp `reasoning_content`, or a `<think>` block), apart from the answer in `delta`. */
  | { type: "reasoning"; text: string }
  /** `cachedTokens`: of the input, how many the server read from its prompt cache (when it says). */
  | { type: "done"; usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } }
  | { type: "error"; message: string };
