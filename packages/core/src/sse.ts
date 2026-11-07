import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Switches a reply to Server-Sent Events and returns a writer.
 *
 * @param request - The request being answered (reserved for per-request options).
 * @param reply - The reply to take over.
 * @returns `send(obj)` writes one `data:` event as JSON; `end()` closes the
 *   stream; `closed` is aborted when the client goes away (pass it on to
 *   providers so generation stops too).
 */
export function startSSE(
  request: FastifyRequest,
  reply: FastifyReply,
): { send: (data: unknown) => void; end: () => void; closed: AbortSignal } {
  const controller = new AbortController();
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // Watch the response, not the request: Node emits the request's "close"
  // as soon as its body has been read, which would abort every stream.
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  void request;
  return {
    send: (data) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    },
    end: () => {
      if (!reply.raw.writableEnded) reply.raw.end();
    },
    closed: controller.signal,
  };
}
