---
name: "my-skill-name"
description: "Describe when this skill should trigger and what it does. Be specific about the situations Claude should reach for it — vague descriptions mean the skill never fires."
---

# Overview

<!--
A short paragraph (2–4 sentences) describing what this skill is for.
Who is it built for? What problem does it solve? What does a successful
invocation look like?
-->

# Instructions

<!--
The step-by-step that Claude should follow when this skill is invoked.
Be explicit. Use numbered steps for ordered procedures, bullets for
guidance.

Examples:

1. Read the user's request and identify the target file.
2. Search the codebase for any existing helper that already does this.
3. If a helper exists, prefer extending it over duplicating logic.
4. Write the change, run the type-check, and report the diff back.

Notes:
- Always prefer to extend existing functions rather than adding new ones.
- Never modify generated code under `out/` directly.
- Stop and ask before making destructive filesystem changes.
-->

# Examples

<!--
At least one worked example showing the skill in action. Include both
the user's prompt and the expected response shape.

## Example 1: <short title>

**User asks:** <quote of the prompt>

**Skill response:**

> Step-by-step of what Claude does, including the exact tool calls or
> files it touches.

## Example 2: <a different shape — e.g. an edge case or refusal>

**User asks:** <quote>

**Skill response:**

> Why this case is handled differently and what the right response is.
-->
