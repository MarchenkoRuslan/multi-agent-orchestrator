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

  it('embeds the agent execution trace as a Mermaid sequence diagram only when one was recorded', () => {
    const plain = ReviewReportSchema.parse(validReport);
    expect(generator.generateMarkdownReport(plain)).not.toContain('```mermaid');
    expect(generator.generateHTMLReport(plain)).not.toContain('script-src');

    const traced = ReviewReportSchema.parse(structuredClone(validReport));
    traced.metadata.executionTrace = [
      { from: 'orchestrator', to: 'code-quality-analyzer', label: 'Task', kind: 'call' },
      { from: 'code-quality-analyzer', to: 'ESLint MCP', label: 'lint-files', kind: 'call' },
      { from: 'code-quality-analyzer', to: 'orchestrator', label: 'findings', kind: 'return' }
    ];
    const markdown = generator.generateMarkdownReport(traced);
    expect(markdown).toContain('## Agent Execution Trace');
    expect(markdown).toContain('```mermaid\nsequenceDiagram');
    expect(markdown).toContain('P1->>P2: lint-files');
    expect(markdown).toContain('| code-quality-analyzer | lint-files x1 |');

    const html = generator.generateHTMLReport(traced);
    expect(html).toContain('<pre class="mermaid">sequenceDiagram');
    expect(html).toContain('P1-&gt;&gt;P2: lint-files');
    expect(html).toMatch(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@[\d.]+\/dist\/mermaid\.min\.js" integrity="sha384-/);
    expect(html).toContain("script-src https://cdn.jsdelivr.net;");
    expect(html).not.toContain('<script>');
  });

  it('builds a compact PR comment with the summary, top recommendations and severe issues', () => {
    const report = ReviewReportSchema.parse(structuredClone(validReport));
    report.fileReviews[0]!.codeQuality.issues.push({ line: 3, severity: 'low', category: 'style', description: 'Minor naming nit.',
      suggestion: 'Rename.' });
    const comment = generator.generatePullRequestComment(report);
    expect(comment.startsWith('<!-- devflow-code-review -->')).toBe(true);
    expect(comment).toContain('## DevFlow Code Review: PR #2');
    expect(comment).toContain('| 85/100 | 1 | 0 | 1 | 1 |');
    expect(comment).toContain('**HIGH / testing**');
    expect(comment).toContain('src/search\\.ts:10');
    expect(comment).not.toContain('Minor naming nit');
  });
});