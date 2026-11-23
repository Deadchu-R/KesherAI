/**
 * Splits a streamed answer into the model's thinking and its reply when the thinking arrives inline as a
 * `<think>…</think>` block (llama-server started with `--reasoning-format none`, or a template that opens the block
 * in the prompt). Chunks can cut a tag in half, so a possible partial tag is held back until the next chunk.
 */
export class ThinkSplitter {
  private inThink = false;
  private held = "";

  /**
   * @param startsInside - True when the template already opened the block in the prompt (the stream then starts
   *   with thinking and only a closing `</think>` shows).
   */
  constructor(startsInside = false) {
    this.inThink = startsInside;
  }

  /**
   * Feeds one chunk of streamed text.
   *
   * @param chunk - The next piece of `content`.
   * @returns The parts of it that are reply text and thinking text (either may be empty).
   */
  push(chunk: string): { text: string; reasoning: string } {
    let buf = this.held + chunk;
    this.held = "";
    let text = "";
    let reasoning = "";
    for (;;) {
      const tag = this.inThink ? "</think>" : "<think>";
      const at = buf.indexOf(tag);
      if (at >= 0) {
        if (this.inThink) reasoning += buf.slice(0, at);
        else text += buf.slice(0, at);
        buf = buf.slice(at + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // Hold back a tail that could be the start of the tag.
      let keep = 0;
      for (let n = Math.min(tag.length - 1, buf.length); n > 0; n--) {
        if (tag.startsWith(buf.slice(buf.length - n))) {
          keep = n;
          break;
        }
      }
      const out = buf.slice(0, buf.length - keep);
      this.held = buf.slice(buf.length - keep);
      if (this.inThink) reasoning += out;
      else text += out;
      return { text, reasoning };
    }
  }

  /** Ends the stream: whatever was held back (a tag that never completed) comes out as plain text or thinking. */
  flush(): { text: string; reasoning: string } {
    const rest = this.held;
    this.held = "";
    return this.inThink ? { text: "", reasoning: rest } : { text: rest, reasoning: "" };
  }
}
