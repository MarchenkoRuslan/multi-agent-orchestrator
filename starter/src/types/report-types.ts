import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  CodeQualityResultSchema,
  TestCoverageResultSchema,
  RefactoringSuggestionSchema
} from './analysis-results.js';

/**
 * One observed step of the multi-agent session, recorded by the orchestrator from SDK messages
 * (never produced by the model). `call` is a tool invocation; `return` is a subagent handing back results.
 */
export const ExecutionTraceEventSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string(),
  kind: z.enum(['call', 'return'])
});

export type ExecutionTraceEvent = z.infer<typeof ExecutionTraceEventSchema>;

const MetadataSchema = z.object({
  analyzedAt: z.string().datetime(),
  duration: z.number().finite().nonnegative(),
  agentVersions: z.record(z.string().min(1))
});

/**
 * Report shape the model must return. Kept separate so host-only metadata (the execution trace)
 * is not part of the structured-output contract sent to Claude.
 */
const ModelReviewReportSchema = z.object({
  pullRequest: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive()
  }),
  fileReviews: z.array(z.object({
    file: z.string().min(1),
    codeQuality: CodeQualityResultSchema,
    testCoverage: TestCoverageResultSchema,
    refactorings: RefactoringSuggestionSchema
  })),
  summary: z.object({
    totalFiles: z.number().int().nonnegative(),
    overallScore: z.number().min(0).max(100),
    criticalIssues: z.number().int().nonnegative(),
    highPriorityTests: z.number().int().nonnegative(),
    refactoringOpportunities: z.number().int().nonnegative()
  }),
  recommendations: z.array(z.object({
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    category: z.string().min(1),
    description: z.string().min(1),
    files: z.array(z.string().min(1))
  })),
  metadata: MetadataSchema
});

/**
 * Complete Review Report Schema
 * Aggregates all subagent results into a unified report, plus the host-recorded execution trace.
 */
export const ReviewReportSchema = ModelReviewReportSchema.extend({
  metadata: MetadataSchema.extend({
    executionTrace: z.array(ExecutionTraceEventSchema).optional()
  })
});

/**
 * TypeScript type inferred from Zod schema
 */
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

type JsonSchema = Record<string, unknown>;
const toJsonSchema = (schema: z.ZodTypeAny): JsonSchema =>
  (zodToJsonSchema as (s: unknown, options?: unknown) => unknown)(
    schema,
    { $refStrategy: 'root' }
  ) as JsonSchema;

/**
 * Removes `format` keywords. Claude Code compiles the structured-output schema with Ajv in strict mode and no
 * format plugins; an unknown format such as "date-time" fails compilation and the CLI then silently drops the
 * StructuredOutput tool. Formats are still enforced by the Zod schema when the host parses the result.
 */
const withoutFormats = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutFormats);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => !(key === 'format' && typeof entry === 'string'))
    .map(([key, entry]) => [key, withoutFormats(entry)]));
};

/**
 * JSON Schema for SDK structured outputs
 * Per SDK docs: https://platform.claude.com/docs/en/agent-sdk/structured-outputs
 * Use $refStrategy: 'root' to properly inline all $ref definitions
 */
export const ReviewReportJSONSchema = withoutFormats(toJsonSchema(ModelReviewReportSchema)) as JsonSchema;
