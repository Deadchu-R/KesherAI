/** A plugin install or update job (Unreal: build, wait for the editor to close, copy). */
export interface Job { state: "building" | "waiting" | "copying" | "done" | "failed"; project: string; engine: string; log: string[]; message?: string }
