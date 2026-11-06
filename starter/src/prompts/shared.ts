/**
 * Rules shared by all specialist prompts.
 * Skills load as extra instructions mid-conversation; without these rules a model can adopt a Skill's
 * prose report format and stop before the remaining steps, breaking the JSON contract the orchestrator parses.
 */
export const SKILL_USAGE_RULES = `Skills are reference guidance only. After a Skill loads, apply it and continue with the next
Process step. Never stop early or answer in a Skill's report format.`;

export const SNAPSHOT_SEARCH_RULES = `The task message lists the changed files and the snapshot's supporting files
(every discovered related source and test file). Read those paths directly instead of repeatedly searching the
tree with Glob; use at most a few targeted Grep/Glob calls for references the lists do not answer.`;

export const FINAL_MESSAGE_RULE = `Your final message must be ONLY the JSON array described below: no Markdown headings, prose or code fences.`;
