import { describe, expect, it } from 'vitest';
import { ReportGenerator } from '../src/utils/report-generator.js';
import { ReviewReportSchema } from '../src/types/report-types.js';
import { validReport } from './fixtures/review-report.js';

describe('ReportGenerator', () => {
  const generator = new ReportGenerator();

  it('renders all findings, suggested assertions, and code examples in every format', () => {
    const report = ReviewReportSchema.parse(validReport);
    for (const text of [generator.generateHTMLReport(report), generator.generateMarkdownReport(report)]) {
      expect(text).toContain('src/search');
      expect(text).toContain('Line 10');
      expect(text).toContain('HIGH');
      expect(text).toContain('toEqual(todos)');
      expect(text).toContain('normalizeQuery');
      expect(text).toContain('Before');
      expect(text).toContain('After');
    }
    expect(ReviewReportSchema.parse(JSON.parse(generator.generateJSONReport(report)))).toEqual(report);
  });

  it('escapes repository-controlled HTML and fences Markdown code safely', () => {
    const report = ReviewReportSchema.parse(validReport);
    report.fileReviews[0]!.codeQuality.summary = '<script>alert("xss")</script>';
    report.fileReviews[0]!.refactorings.suggestions[0]!.before = '```\n<script>bad()</script>\n```';
    const rendered = generator.generateHTMLReport(report);
    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;');
    expect(rendered).toContain('Content-Security-Policy');
    expect(generator.generateMarkdownReport(report)).toContain('````text');
  });

  it('does not truncate findings beyond the old three-issue limit', () => {
    const report = ReviewReportSchema.parse(validReport);
    const issue = report.fileReviews[0]!.codeQuality.issues[0]!;
    report.fileReviews[0]!.codeQuality.issues = Array.from({ length: 6 }, (_, index) => ({ ...issue, description: `Unique finding ${index}` }));
    expect(generator.generateHTMLReport(report)).toContain('Unique finding 5');
    expect(generator.generateMarkdownReport(report)).toContain('Unique finding 5');
  });
});