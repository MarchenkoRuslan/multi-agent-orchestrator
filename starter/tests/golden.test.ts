import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { evaluateReport } from '../src/eval/evaluate.js';
import { goldenDataset, type GoldenCase } from '../src/eval/golden-dataset.js';
import { reportFileFor, runGoldenEvaluation } from '../src/eval/run-eval.js';
import { ReviewReportSchema, type ReviewReport } from '../src/types/report-types.js';
import { validReport } from './fixtures/review-report.js';

const goldenCase = (id: string): GoldenCase => goldenDataset.find(item => item.id === id)!;

function reportFor(golden: GoldenCase, edit: (report: ReviewReport) => void): ReviewReport {
  const report = ReviewReportSchema.parse(structuredClone(validReport));
  report.pullRequest = { ...golden.pullRequest };
  const file = golden.expectedFiles[0]!;
  const review = report.fileReviews[0]!;
  review.file = review.codeQuality.file = review.testCoverage.file = review.refactorings.file = file;
  edit(report);
  return report;
}

const sqlInjection = (line: number) => ({ line, severity: 'critical' as const, category: 'security' as const,
  description: 'User input is interpolated into the SQL string, enabling SQL injection.', suggestion: 'Use parameterized queries.' });

describe('golden dataset evaluator', () => {
  it('passes a report that detects the known SQL injections', () => {
    const golden = goldenCase('pr2-sql-injection');
    const report = reportFor(golden, value => {
      value.fileReviews[0]!.codeQuality.issues = [sqlInjection(121), sqlInjection(133), sqlInjection(143)];
      value.summary.overallScore = 10;
    });
    const result = evaluateReport(report, golden);
    expect(result.checks.filter(item => !item.passed)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails a report that misses the injections or flags them with a low severity', () => {
    const golden = goldenCase('pr2-sql-injection');
    const missed = evaluateReport(reportFor(golden, () => {}), golden);
    expect(missed.passed).toBe(false);
    const lowSeverity = evaluateReport(reportFor(golden, value => {
      value.fileReviews[0]!.codeQuality.issues = [121, 132].map(line => ({ ...sqlInjection(line), severity: 'low' as const }));
      value.summary.overallScore = 10;
    }), golden);
    expect(lowSeverity.checks.find(item => item.name.startsWith('SQL injection'))?.passed).toBe(false);
  });

  it('requires untested payment functions for the premium PR and no false criticals for the clean control', () => {
    const premium = goldenCase('pr3-untested-payment-logic');
    const gaps = ['processPremiumPayment', 'validatePaymentDetails', 'chargeCard'].map(name => ({ type: 'function' as const,
      location: `src/premium.ts:${name}`, priority: 'critical' as const, reasoning: 'Payment path is untested.', suggestedTest: 'it(...)' }));
    expect(evaluateReport(reportFor(premium, value => { value.fileReviews[0]!.testCoverage.untestedPaths = gaps; }), premium).passed).toBe(true);
    expect(evaluateReport(reportFor(premium, value => { value.fileReviews[0]!.testCoverage.hasTests = true; }), premium).passed).toBe(false);

    const control = goldenCase('pr1-clean-code-control');
    expect(evaluateReport(reportFor(control, () => {}), control).passed).toBe(true);
    expect(evaluateReport(reportFor(control, value => { value.summary.criticalIssues = 2; }), control).passed).toBe(false);
  });

  it('fails cases whose report file is missing', async () => {
    const results = await runGoldenEvaluation(join(fileURLToPath(new URL('.', import.meta.url)), 'no-such-reports'));
    expect(results.every(result => !result.passed && result.checks[0]!.name === 'load report')).toBe(true);
  });
});

const reportsDir = fileURLToPath(new URL('../reports', import.meta.url));
const committedReportsExist = goldenDataset.every(golden => existsSync(join(reportsDir, reportFileFor(golden))));

describe.runIf(committedReportsExist)('regression: committed live reports satisfy the golden dataset', () => {
  it.each(goldenDataset.map(golden => [golden.id]))('%s', async id => {
    const [result] = await runGoldenEvaluation(reportsDir, goldenDataset.filter(golden => golden.id === id));
    expect(result!.checks.filter(item => !item.passed)).toEqual([]);
  });
});
