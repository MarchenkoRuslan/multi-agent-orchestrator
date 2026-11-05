import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Structured output schemas for subagent analysis results
 * Uses Zod for runtime validation and converts to JSON Schema for SDK
 */

// Code Quality Analyzer output schema
export const CodeQualityResultSchema = z.object({
  file: z.string().min(1),
  issues: z.array(z.object({
    line: z.number().int().positive(),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    category: z.enum([
      'security',
      'performance',
      'maintainability',
      'style',
      'bug-risk',
      'best-practice'
    ]),
    description: z.string().min(1),
    suggestion: z.string().min(1)
  })),
  overallScore: z.number().min(0).max(100),
  summary: z.string().min(1)
});

// Test Coverage Analyzer output schema
export const TestCoverageResultSchema = z.object({
  file: z.string().min(1),
  hasTests: z.boolean(),
  testFiles: z.array(z.string().min(1)),
  untestedPaths: z.array(z.object({
    type: z.enum(['function', 'class', 'branch', 'edge-case']),
    location: z.string().min(1),
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    reasoning: z.string().min(1),
    suggestedTest: z.string().min(1)
  })),
  coverageEstimate: z.number().min(0).max(100),
  summary: z.string().min(1)
});

// Refactoring Suggester output schema
export const RefactoringSuggestionSchema = z.object({
  file: z.string().min(1),
  suggestions: z.array(z.object({
    type: z.enum([
      'extract-function',
      'rename',
      'modernize',
      'simplify',
      'pattern-improvement'
    ]),
    location: z.string().min(1),
    impact: z.enum(['low', 'medium', 'high']),
    description: z.string().min(1),
    before: z.string().min(1),
    after: z.string().min(1),
    benefits: z.string().min(1)
  })),
  summary: z.string().min(1)
});

// TypeScript type exports
export type CodeQualityResult = z.infer<typeof CodeQualityResultSchema>;
export type TestCoverageResult = z.infer<typeof TestCoverageResultSchema>;
export type RefactoringSuggestion = z.infer<typeof RefactoringSuggestionSchema>;

type JsonSchema = Record<string, unknown>;
const toJsonSchema = (schema: z.ZodTypeAny): JsonSchema =>
  (zodToJsonSchema as (s: unknown, options?: unknown) => unknown)(
    schema,
    { $refStrategy: 'root' }
  ) as JsonSchema;

/**
 * Convert Zod schemas to JSON Schema for SDK structured outputs
 * Per SDK docs: https://platform.claude.com/docs/en/agent-sdk/structured-outputs
 * Use $refStrategy: 'root' to properly inline all $ref definitions
 */
export const CodeQualityResultJSONSchema: JsonSchema = toJsonSchema(CodeQualityResultSchema);
export const TestCoverageResultJSONSchema: JsonSchema = toJsonSchema(TestCoverageResultSchema);
export const RefactoringSuggestionJSONSchema: JsonSchema = toJsonSchema(RefactoringSuggestionSchema);
