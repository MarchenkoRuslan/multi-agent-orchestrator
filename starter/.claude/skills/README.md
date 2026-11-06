# Claude Skills

This directory contains Claude Skills - reusable domain expertise that agents can invoke.

## What Are Skills?

Skills are markdown files that provide Claude with specialized knowledge for specific tasks. They're loaded automatically by the Claude Agent SDK when agents invoke them.

## Available Skills

| Skill | Used by | When |
| --- | --- | --- |
| `javascript-best-practices` | code-quality-analyzer, refactoring-suggester | `.js`, `.jsx`, `.mjs`, `.cjs` files (provided example) |
| `typescript-patterns` | code-quality-analyzer, refactoring-suggester, test-coverage-analyzer | `.ts`, `.tsx`, `.mts`, `.cts` files |
| `security-analysis` | code-quality-analyzer | Every changed source file (trust boundaries, injection, payments, auth) |
| `test-analysis` | test-coverage-analyzer | Every changed source file (static coverage, assertions, test gaps) |
| `refactoring-analysis` | refactoring-suggester | Every changed source file (extractions, deduplication, patterns) |

The agent prompts in `src/prompts/` contain the exact file-type mapping. Each review copies this
directory into the isolated snapshot so only these trusted skills are available to the agents.

## Skill File Structure

Each skill must be in its own folder with a `SKILL.md` file:

```
.claude/skills/
├── javascript-best-practices/SKILL.md
├── typescript-patterns/SKILL.md
├── security-analysis/SKILL.md
├── test-analysis/SKILL.md
└── refactoring-analysis/SKILL.md
```

## SKILL.md Format

```markdown
---
description: Brief description of what this skill provides
---

# Skill Name

Brief introduction

## Section 1: Topic Area

Content, guidelines, examples

## Section 2: Another Topic

More content

## Output:

What format/guidance the skill should return
```

## How Agents Invoke Skills

In your agent prompts, use:

```
For .ts files: invoke Skill "typescript-patterns"
```

The Claude Agent SDK will:
1. Load the SKILL.md file
2. Inject its content into the agent's context
3. Agent uses the knowledge to provide expert analysis

## Tips for Writing Skills

✅ **DO:**
- Be specific and actionable
- Include code examples
- Organize by category
- Provide severity guidelines
- Show good vs bad patterns

❌ **DON'T:**
- Make it too long (keep under 500 lines)
- Include full tutorials (just key points)
- Duplicate general knowledge Claude already has
- Use generic advice (be domain-specific)

## Example: Invoking a Skill

In `code-quality-analyzer` prompt:

```typescript
## Process:
1. Read the code file with Read tool
2. Invoke Skills based on file type:
   - .ts/.tsx files: invoke Skill "typescript-patterns"
   - .js/.jsx files: invoke Skill "javascript-best-practices"
   - .py files: invoke Skill "python-code-review"
   - ALL files: invoke Skill "security-analysis"
3. Analyze using the skill's guidance
4. Return structured feedback
```

## Resources

- [Claude Agent SDK Skills Documentation](https://platform.claude.com/docs/en/agent-sdk/skills)
- Example: See `javascript-best-practices/SKILL.md` in this directory
