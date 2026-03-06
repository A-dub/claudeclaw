---
name: self-improving-agent
description: "Captures learnings, errors, and corrections to enable continuous improvement. Use when: (1) A command or operation fails unexpectedly, (2) User corrects you ('No, that's wrong...', 'Actually...'), (3) A better approach is discovered, (4) An external API or tool fails, (5) Knowledge is outdated or incorrect. Also review learnings before major tasks."
---

# Self-Improving Agent

Log learnings, errors, and corrections to enable continuous self-improvement across sessions.

## Quick Reference

| Situation | Action |
|-----------|--------|
| Command/operation fails | Log to `.learnings/ERRORS.md` |
| User corrects you | Log to `.learnings/LEARNINGS.md` with category `correction` |
| User wants missing feature | Log to `.learnings/FEATURE_REQUESTS.md` |
| API/external tool fails | Log to `.learnings/ERRORS.md` with integration details |
| Knowledge was outdated | Log to `.learnings/LEARNINGS.md` with category `knowledge_gap` |
| Found better approach | Log to `.learnings/LEARNINGS.md` with category `best_practice` |
| Broadly applicable learning | Promote to memory system or CLAUDE.md |

## Setup

Create the learnings directory if it doesn't exist:

```bash
mkdir -p .learnings
```

Files used:
- `.learnings/LEARNINGS.md` — corrections, knowledge gaps, best practices
- `.learnings/ERRORS.md` — command failures, exceptions
- `.learnings/FEATURE_REQUESTS.md` — user-requested capabilities

## Logging Format

### Learning Entry

Append to `.learnings/LEARNINGS.md`:

```markdown
## [LRN-YYYYMMDD-XXX] category

**Logged**: ISO-8601 timestamp
**Priority**: low | medium | high | critical
**Status**: pending
**Area**: frontend | backend | infra | tests | docs | config

### Summary
One-line description of what was learned

### Details
Full context: what happened, what was wrong, what's correct

### Suggested Action
Specific fix or improvement to make
```

### Error Entry

Append to `.learnings/ERRORS.md`:

```markdown
## [ERR-YYYYMMDD-XXX] skill_or_command_name

**Logged**: ISO-8601 timestamp
**Priority**: high
**Status**: pending

### Summary
Brief description of what failed

### Error
Actual error message or output

### Context
Command attempted, parameters, environment details

### Suggested Fix
What might resolve this
```

### Feature Request Entry

Append to `.learnings/FEATURE_REQUESTS.md`:

```markdown
## [FEAT-YYYYMMDD-XXX] capability_name

**Logged**: ISO-8601 timestamp
**Priority**: medium
**Status**: pending

### Requested Capability
What the user wanted to do

### Suggested Implementation
How this could be built
```

## ID Generation

Format: `TYPE-YYYYMMDD-XXX`
- TYPE: `LRN` (learning), `ERR` (error), `FEAT` (feature)
- YYYYMMDD: Current date
- XXX: Sequential number (e.g., `001`, `002`)

## Promotion to Memory

When a learning is broadly applicable (not a one-off fix), promote it:

1. **Distill** the learning into a concise rule
2. **Save** to the memory system (feedback type for corrections, project type for project knowledge)
3. **Update** original entry status to `promoted`

### When to Promote

- Learning applies across multiple files/features
- Knowledge any session should know
- Prevents recurring mistakes
- Documents project-specific conventions

## Detection Triggers

Automatically log when you notice:

**Corrections** (category `correction`):
- "No, that's not right..."
- "Actually, it should be..."
- "You're wrong about..."

**Knowledge Gaps** (category `knowledge_gap`):
- User provides information you didn't know
- Documentation you referenced is outdated

**Errors** (error entry):
- Command returns non-zero exit code
- Exception or stack trace
- Unexpected output or behavior

## Recurring Pattern Detection

If logging something similar to an existing entry:

1. **Search first**: `grep -r "keyword" .learnings/`
2. **Link entries**: Add `See Also: ERR-YYYYMMDD-XXX`
3. **Bump priority** if issue keeps recurring
4. **Promote** recurring issues to memory/CLAUDE.md

## Resolving Entries

When an issue is fixed, update the entry:

1. Change `**Status**: pending` to `**Status**: resolved`
2. Add resolution note with date and what was done

## Best Practices

1. **Log immediately** — context is freshest right after the issue
2. **Be specific** — future sessions need to understand quickly
3. **Include reproduction steps** — especially for errors
4. **Suggest concrete fixes** — not just "investigate"
5. **Promote aggressively** — if in doubt, add to memory
