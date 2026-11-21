import { useEffect, useState } from "react";
import { api } from "../api";

/** Something an agent waits for the user to approve. */
export interface Pending { kind?: "chat" | "self-work"; conversationId: string; title: string; requestId: string; tool: string; preview: string; reason: string; purpose?: string; at: string }

/** @returns What waits for approval now (polled). */
export function usePending(every = 4000): Pending[] {
  const [list, setList] = useState<Pending[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = () => api<Pending[]>("/api/approvals").then((l) => alive && setList(l), () => undefined);
    void tick();
    const id = setInterval(tick, every);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [every]);
  return list;
}
