import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  CodeQualityResultSchema,
  TestCoverageResultSchema,
  RefactoringSuggestionSchema
} from './analysis-results.js';

/**
 * Complete Review Report Schema
 * Aggregates all subagent results into a unified report
 */
export const ReviewReportSchema = z.object({
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
  metadata: z.object({
    analyzedAt: z.string().datetime(),
    duration: z.number().finite().nonnegative(),
    agentVersions: z.record(z.string().min(1))
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
 * JSON Schema for SDK structured outputs
 * Per SDK docs: https://platform.claude.com/docs/en/agent-sdk/structured-outputs
 * Use $refStrategy: 'root' to properly inline all $ref definitions
 */
const rawSchema: JsonSchema = toJsonSchema(ReviewReportSchema);

// Extract the actual schema - zodToJsonSchema may wrap it with extra properties
export const ReviewReportJSONSchema = rawSchema;
