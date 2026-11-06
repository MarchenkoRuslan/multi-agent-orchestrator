import type { ExecutionTraceEvent } from '../types/report-types.js';

export const MAX_DIAGRAM_STEPS = 150;

/**
 * Keeps Mermaid-safe characters only, so repository-controlled text (file names, grep patterns)
 * cannot inject diagram syntax, directives, or HTML.
 */
export function sanitizeMermaidText(text: string): string {
  return text.replace(/[^\w .\-/@]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Builds a Mermaid sequence diagram showing which tools each agent triggered and in what order.
 */
export function buildSequenceDiagram(trace: readonly ExecutionTraceEvent[], maxSteps = MAX_DIAGRAM_STEPS): string {
  const participantIds = new Map<string, string>();
  const idFor = (name: string): string => {
    let id = participantIds.get(name);
    if (!id) {
      id = `P${participantIds.size}`;
      participantIds.set(name, id);
    }
    return id;
  };

  idFor('orchestrator');
  const steps = trace.slice(0, maxSteps).map(event => {
    const arrow = event.kind === 'call' ? '->>' : '-->>';
    const label = sanitizeMermaidText(event.label) || event.kind;
    return `  ${idFor(event.from)}${arrow}${idFor(event.to)}: ${label}`;
  });
  if (trace.length > maxSteps) {
    steps.push(`  Note over P0: ${trace.length - maxSteps} more steps omitted`);
  }

  const participants = [...participantIds].map(([name, id]) =>
    `  participant ${id} as ${sanitizeMermaidText(name) || id}`);
  return ['sequenceDiagram', ...participants, ...steps].join('\n');
}

/**
 * Counts tool calls per actor, e.g. { "code-quality-analyzer": { "lint-files": 2 } }.
 */
export function summarizeToolUsage(trace: readonly ExecutionTraceEvent[]): Map<string, Map<string, number>> {
  const usage = new Map<string, Map<string, number>>();
  for (const event of trace) {
    if (event.kind !== 'call') continue;
    const tool = event.label.split(' ')[0] || event.label;
    const counts = usage.get(event.from) ?? new Map<string, number>();
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
    usage.set(event.from, counts);
  }
  return usage;
}
