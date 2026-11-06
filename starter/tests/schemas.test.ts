import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { ZodError } from 'zod';
import { CodeQualityResultSchema, CodeQualityResultJSONSchema, TestCoverageResultSchema,
  TestCoverageResultJSONSchema, RefactoringSuggestionSchema, RefactoringSuggestionJSONSchema } from '../src/types/analysis-results.js';
import { ReviewReportSchema, ReviewReportJSONSchema } from '../src/types/report-types.js';

import { validReport } from './fixtures/review-report.js';

describe('analysis and report schemas', () => {
  it('throws ZodError for invalid data in every public result schema', () => {
    for (const schema of [CodeQualityResultSchema, TestCoverageResultSchema, RefactoringSuggestionSchema, ReviewReportSchema]) {
      expect(() => schema.parse({})).toThrow(ZodError);
    }
  });

  it('accepts populated results and an empty changed-file set', () => {
    expect(ReviewReportSchema.safeParse(validReport).success).toBe(true);
    expect(ReviewReportSchema.safeParse({ ...validReport, fileReviews: [], recommendations: [],
      summary: { ...validReport.summary, totalFiles: 0 } }).success).toBe(true);
  });

  it.each([0, 100])('accepts boundary score %s', score => {
    expect(CodeQualityResultSchema.safeParse({ ...validReport.fileReviews[0]!.codeQuality, issues: [], overallScore: score }).success).toBe(true);
    expect(TestCoverageResultSchema.safeParse({ ...validReport.fileReviews[0]!.testCoverage, untestedPaths: [], coverageEstimate: score }).success).toBe(true);
  });

  it.each([-1, 101, NaN, Infinity])('rejects invalid score %s', score => {
    expect(CodeQualityResultSchema.safeParse({ ...validReport.fileReviews[0]!.codeQuality, overallScore: score }).success).toBe(false);
  });

  it('rejects missing fields, invalid severity, invalid lines, and invalid PR numbers', () => {
    expect(ReviewReportSchema.safeParse({}).success).toBe(false);
    const quality = validReport.fileReviews[0]!.codeQuality;
    expect(CodeQualityResultSchema.safeParse({ ...quality, issues: [{ ...quality.issues[0], severity: 'urgent' }] }).success).toBe(false);
    for (const line of [0, -1, 1.5]) {
      expect(CodeQualityResultSchema.safeParse({ ...quality, issues: [{ ...quality.issues[0], line }] }).success).toBe(false);
    }
    expect(ReviewReportSchema.safeParse({ ...validReport, pullRequest: { ...validReport.pullRequest, number: 0 } }).success).toBe(false);
    expect(RefactoringSuggestionSchema.safeParse({ file: '', suggestions: [], summary: '' }).success).toBe(false);
  });

  it('accepts a host-recorded execution trace but keeps it out of the model-facing JSON schema', () => {
    const traced = { ...validReport, metadata: { ...validReport.metadata,
      executionTrace: [{ from: 'orchestrator', to: 'code-quality-analyzer', label: 'Task', kind: 'call' }] } };
    expect(ReviewReportSchema.safeParse(traced).success).toBe(true);
    expect(ReviewReportSchema.safeParse({ ...traced, metadata: { ...traced.metadata,
      executionTrace: [{ from: 'orchestrator', to: '', label: 'Task', kind: 'jump' }] } }).success).toBe(false);
    expect(JSON.stringify(ReviewReportJSONSchema)).not.toContain('executionTrace');
  });

  it('exports usable JSON schemas with resolved references for structured output', () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    for (const [schema, value] of [
      [ReviewReportJSONSchema, validReport],
      [CodeQualityResultJSONSchema, validReport.fileReviews[0]!.codeQuality],
      [TestCoverageResultJSONSchema, validReport.fileReviews[0]!.testCoverage],
      [RefactoringSuggestionJSONSchema, validReport.fileReviews[0]!.refactorings]
    ] as const) {
      const validate = ajv.compile(schema);
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({})).toBe(false);
    }
  });

  it('compiles the structured-output schema exactly as Claude Code does', () => {
    // Claude Code builds its StructuredOutput tool with `new Ajv({ allErrors: true })` (strict, no format plugins)
    // and silently drops the tool if compilation throws, leaving the model to answer in free text.
    const ajv = new Ajv({ allErrors: true });
    expect(ajv.validateSchema(ReviewReportJSONSchema)).toBe(true);
    const validate = ajv.compile(ReviewReportJSONSchema);
    expect(validate(validReport), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.stringify(ReviewReportJSONSchema)).not.toContain('"format"');
    expect(ReviewReportSchema.safeParse({ ...validReport, metadata: { ...validReport.metadata, analyzedAt: 'yesterday' } }).success)
      .toBe(false);
  });
});