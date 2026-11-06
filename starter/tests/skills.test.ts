import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillsDir = fileURLToPath(new URL('../.claude/skills', import.meta.url));
const skillNames = readdirSync(skillsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);

describe('Claude Skills library', () => {
  it('ships the skills referenced by the specialist prompts', () => {
    expect(skillNames).toEqual(expect.arrayContaining(
      ['security-analysis', 'typescript-patterns', 'javascript-best-practices', 'test-analysis', 'refactoring-analysis']));
  });

  it.each(skillNames)('%s has valid frontmatter and loads without shell execution', name => {
    const content = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\r?\nname: (.+)\r?\ndescription: (.+)\r?\n---/.exec(content);
    expect(frontmatter?.[1]).toBe(name);
    expect(frontmatter?.[2]?.length).toBeGreaterThan(20);
    // Claude Code runs "!`command`" in SKILL.md as a shell command at load time; review agents have no Bash,
    // so such text makes the Skill fail to load.
    expect(content).not.toMatch(/!`/);
    expect(content.replace(/\s+/g, ' ')).toContain(
      'guidance only: after applying it, continue your remaining steps and return findings in the exact output format');
  });

  it('every specialist prompt keeps skills subordinate to its JSON output contract', async () => {
    const shared = await import('../src/prompts/shared.js');
    const prompts = await Promise.all(['code-quality-analyzer', 'test-coverage-analyzer', 'refactoring-suggester']
      .map(name => readFileSync(fileURLToPath(new URL(`../src/prompts/${name}.prompt.ts`, import.meta.url)), 'utf8')));
    for (const source of prompts) {
      expect(source).toContain('SKILL_USAGE_RULES');
      expect(source).toContain('FINAL_MESSAGE_RULE');
    }
    expect(shared.FINAL_MESSAGE_RULE).toMatch(/JSON array/);
  });
});
