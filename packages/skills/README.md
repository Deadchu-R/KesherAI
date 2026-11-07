# @kesher/skills

Reads skills in the open `SKILL.md` format, so skills written for Claude Code, Codex or found on LobeHub work in Kesher unchanged.

A skill is a folder:

```
my-skill/
  SKILL.md        ← YAML frontmatter (name, description) + instructions
  reference.md    ← optional files the instructions point to
  scripts/…       ← optional
```

Only the `name` and `description` of every skill go into a model's context. When the model decides a skill is relevant, Kesher loads the full `SKILL.md` body (`loadSkillBody`). This keeps hundreds of installed skills cheap.

Kesher looks in `~/.kesher/skills/` and in a project's `.kesher/skills/` (and `.claude/skills/` for compatibility).
