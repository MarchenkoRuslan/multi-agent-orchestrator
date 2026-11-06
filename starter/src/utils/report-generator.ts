import { ReviewReportSchema, type ExecutionTraceEvent, type ReviewReport } from '../types/report-types.js';
import { buildSequenceDiagram, summarizeToolUsage } from './mermaid.js';

type FileReview = ReviewReport['fileReviews'][number];
type Recommendation = ReviewReport['recommendations'][number];

const COVERAGE_NOTE = 'Coverage values are static estimates, not measured test coverage. ' +
  'A 100% value on a non-executable file is an N/A placeholder.';
const TRACE_NOTE = 'Recorded by the orchestrator from the Claude Agent SDK message stream (not written by the model). ' +
  'Each arrow is a tool call; dashed arrows are subagents returning findings.';
const COMMENT_MARKER = '<!-- devflow-code-review -->';
const MAX_COMMENT_RECOMMENDATIONS = 10;
const MAX_COMMENT_ISSUES = 15;

/** Pinned Mermaid build with Subresource Integrity; only loaded when a report contains an execution trace. */
const MERMAID_SCRIPT = {
  src: 'https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.min.js',
  integrity: 'sha384-HHW54r639fK42Ip0coGF3mz8oSiGn0eEoWNTLs75X7H63pLSDBa0Tqs0RwGmLlXE'
};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

const escapeMarkdown = (value: string): string => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/([\\`*_{}[\]()#+.!|])/g, '\\$1');

/** Fences text with a backtick run longer than any run inside it, so content cannot close the block. */
const codeBlock = (value: string, language = 'text'): string => {
  const longest = Math.max(2, ...(value.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${value}\n${fence}`;
};

const agentList = (report: ReviewReport, escape: (value: string) => string): string =>
  Object.entries(report.metadata.agentVersions).map(([name, version]) => `${escape(name)} (${escape(version)})`).join(', ');

const toolUsageRows = (trace: readonly ExecutionTraceEvent[]): Array<[string, string]> =>
  [...summarizeToolUsage(trace)].map(([actor, counts]) =>
    [actor, [...counts].map(([tool, count]) => `${tool} x${count}`).join(', ')]);

/**
 * Report Generator
 * Converts ReviewReport to various output formats (Markdown, HTML, JSON)
 */
export class ReportGenerator {
  /**
   * Generate a Markdown report for PR comments
   */
  generateMarkdownReport(report: ReviewReport): string {
    report = ReviewReportSchema.parse(report);
    const { summary, pullRequest } = report;
    const sections = [
      '# DevFlow Code Review',
      `${escapeMarkdown(pullRequest.owner)}/${escapeMarkdown(pullRequest.repo)} | PR #${pullRequest.number}`,
      '## Summary',
      [
        '| Metric | Value |',
        '| --- | --- |',
        `| Overall quality score | ${summary.overallScore}/100 |`,
        `| Files reviewed | ${summary.totalFiles} |`,
        `| Critical issues | ${summary.criticalIssues} |`,
        `| High-priority test gaps | ${summary.highPriorityTests} |`,
        `| Refactoring opportunities | ${summary.refactoringOpportunities} |`
      ].join('\n'),
      COVERAGE_NOTE,
      '## Recommendations',
      report.recommendations.map((rec, index) => this.markdownRecommendation(rec, index)).join('\n\n') || 'No recommendations.',
      '## File Reviews',
      report.fileReviews.map(review => this.markdownFileReview(review)).join('\n\n---\n\n') ||
        'No changed files; overall score is not applicable.',
      ...this.markdownTrace(report.metadata.executionTrace),
      '---',
      `Analyzed at ${report.metadata.analyzedAt} | Duration: ${report.metadata.duration} ms`,
      `Agents: ${agentList(report, escapeMarkdown)}`
    ];
    return `${sections.join('\n\n')}\n`;
  }

  /**
   * Generate an HTML report for web display
   */
  generateHTMLReport(report: ReviewReport): string {
    report = ReviewReportSchema.parse(report);
    const { summary, pullRequest } = report;
    const trace = report.metadata.executionTrace ?? [];
    const recommendations = report.recommendations.map(rec => this.htmlRecommendation(rec)).join('');
    const files = report.fileReviews.map((review, index) => this.htmlFileReview(review, index)).join('');
    const scriptPolicy = trace.length ? ` script-src ${new URL(MERMAID_SCRIPT.src).origin};` : '';
    const mermaidScript = trace.length
      ? `<script src="${MERMAID_SCRIPT.src}" integrity="${MERMAID_SCRIPT.integrity}" crossorigin="anonymous" ` +
        'referrerpolicy="no-referrer"></script>'
      : '';
    const metric = (value: string | number, label: string): string => `<div><b>${value}</b>${label}</div>`;

    return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';${scriptPolicy} base-uri 'none'; form-action 'none'">
<title>DevFlow Review: PR #${pullRequest.number}</title>
<style>${HTML_STYLES}</style></head>
<body><main>
<header><h1>DevFlow Code Review</h1><p>${escapeHtml(pullRequest.owner)}/${escapeHtml(pullRequest.repo)} <b>PR #${pullRequest.number}</b></p></header>
<div class="summary">${[
      metric(`${summary.overallScore}/100`, 'Overall quality'),
      metric(summary.totalFiles, 'Files reviewed'),
      metric(summary.criticalIssues, 'Critical issues'),
      metric(summary.highPriorityTests, 'High-priority test gaps'),
      metric(summary.refactoringOpportunities, 'Refactorings')
    ].join('')}</div>
<p class="note">${COVERAGE_NOTE}</p>
<h2>Recommendations</h2><ul>${recommendations || '<li>No recommendations.</li>'}</ul>
${files || '<p>No changed files; overall score is not applicable.</p>'}
${this.htmlTrace(trace)}
<footer>Analyzed at ${escapeHtml(report.metadata.analyzedAt)} | Duration: ${report.metadata.duration} ms<p>Agents: ${agentList(report, escapeHtml)}</p></footer>
</main>${mermaidScript}</body></html>
`;
  }

  /**
   * Generate formatted JSON report
   */
  generateJSONReport(report: ReviewReport): string {
    return `${JSON.stringify(ReviewReportSchema.parse(report), null, 2)}\n`;
  }

  /**
   * Generate a compact Markdown summary suitable for a GitHub pull request comment.
   */
  generatePullRequestComment(report: ReviewReport): string {
    report = ReviewReportSchema.parse(report);
    const { summary, pullRequest } = report;
    const recommendations = report.recommendations.slice(0, MAX_COMMENT_RECOMMENDATIONS).map((rec, index) =>
      `${index + 1}. **${rec.priority.toUpperCase()} / ${escapeMarkdown(rec.category)}**: ${escapeMarkdown(rec.description)}`);
    const severeIssues = report.fileReviews.flatMap(review => review.codeQuality.issues
      .filter(issue => issue.severity === 'critical' || issue.severity === 'high')
      .map(issue => `- **${issue.severity.toUpperCase()} / ${issue.category}** ${escapeMarkdown(review.file)}:${issue.line}: ` +
        escapeMarkdown(issue.description)));
    const omittedIssues = severeIssues.length - MAX_COMMENT_ISSUES;

    return [
      COMMENT_MARKER,
      `## DevFlow Code Review: PR #${pullRequest.number}`,
      `| Quality score | Files | Critical issues | High-priority test gaps | Refactorings |\n| --- | --- | --- | --- | --- |\n` +
        `| ${summary.overallScore}/100 | ${summary.totalFiles} | ${summary.criticalIssues} | ${summary.highPriorityTests} | ` +
        `${summary.refactoringOpportunities} |`,
      '### Top recommendations',
      recommendations.join('\n') || 'No recommendations.',
      '### Critical and high-severity issues',
      [...severeIssues.slice(0, MAX_COMMENT_ISSUES), ...(omittedIssues > 0 ? [`- ...and ${omittedIssues} more`] : [])]
        .join('\n') || 'None found.',
      '_Generated by the DevFlow multi-agent reviewer (code quality, test coverage, refactoring subagents). ' +
        'Coverage values are static estimates._'
    ].join('\n\n') + '\n';
  }

  private markdownRecommendation(rec: Recommendation, index: number): string {
    return `${index + 1}. **${rec.priority.toUpperCase()} / ${escapeMarkdown(rec.category)}**: ${escapeMarkdown(rec.description)}\n\n` +
      `Files: ${rec.files.map(escapeMarkdown).join(', ')}`;
  }

  private markdownFileReview(review: FileReview): string {
    const issues = review.codeQuality.issues.map(issue =>
      `- **${issue.severity.toUpperCase()} | ${issue.category} | Line ${issue.line}**: ${escapeMarkdown(issue.description)}\n\n` +
      `  Fix: ${escapeMarkdown(issue.suggestion)}`).join('\n\n');
    const tests = review.testCoverage.untestedPaths.map(path =>
      `- **${path.priority.toUpperCase()} | ${escapeMarkdown(path.location)}**: ${escapeMarkdown(path.reasoning)}\n\n` +
      codeBlock(path.suggestedTest)).join('\n\n');
    const refactorings = review.refactorings.suggestions.map(suggestion => [
      `#### ${escapeMarkdown(suggestion.type)}: ${escapeMarkdown(suggestion.location)}`,
      `Impact: ${suggestion.impact}`,
      escapeMarkdown(suggestion.description),
      `Before:\n\n${codeBlock(suggestion.before)}`,
      `After:\n\n${codeBlock(suggestion.after)}`,
      `Benefits: ${escapeMarkdown(suggestion.benefits)}`
    ].join('\n\n')).join('\n\n');
    const testFiles = review.testCoverage.testFiles.map(escapeMarkdown).join(', ') || 'None identified.';

    return [
      `### ${escapeMarkdown(review.file)}`,
      `Quality: ${review.codeQuality.overallScore}/100 | Static coverage estimate: ${review.testCoverage.coverageEstimate}%`,
      escapeMarkdown(review.codeQuality.summary),
      '#### Quality Issues',
      issues || 'No issues identified.',
      '#### Test Coverage',
      escapeMarkdown(review.testCoverage.summary),
      `Existing tests: ${testFiles}`,
      tests || 'No additional test gaps identified.',
      '#### Refactoring',
      escapeMarkdown(review.refactorings.summary),
      refactorings || 'No worthwhile refactoring identified.'
    ].join('\n\n');
  }

  private markdownTrace(trace: readonly ExecutionTraceEvent[] | undefined): string[] {
    if (!trace?.length) return [];
    const rows = toolUsageRows(trace).map(([actor, tools]) => `| ${escapeMarkdown(actor)} | ${escapeMarkdown(tools)} |`);
    return [
      '## Agent Execution Trace',
      TRACE_NOTE,
      ['| Actor | Tool calls |', '| --- | --- |', ...rows].join('\n'),
      codeBlock(buildSequenceDiagram(trace), 'mermaid')
    ];
  }

  private htmlRecommendation(rec: Recommendation): string {
    return `<li class="${rec.priority}"><strong>${rec.priority.toUpperCase()} / ${escapeHtml(rec.category)}</strong>` +
      `<p>${escapeHtml(rec.description)}</p><small>${rec.files.map(escapeHtml).join(', ')}</small></li>`;
  }

  private htmlFileReview(review: FileReview, index: number): string {
    const issues = review.codeQuality.issues.map(issue =>
      `<li class="${issue.severity}"><strong>${issue.severity.toUpperCase()} / ${escapeHtml(issue.category)} / Line ${issue.line}</strong>` +
      `<p>${escapeHtml(issue.description)}</p><p><b>Fix:</b> ${escapeHtml(issue.suggestion)}</p></li>`).join('');
    const tests = review.testCoverage.untestedPaths.map(path =>
      `<li class="${path.priority}"><strong>${path.priority.toUpperCase()} / ${escapeHtml(path.location)}</strong>` +
      `<p>${escapeHtml(path.reasoning)}</p><pre><code>${escapeHtml(path.suggestedTest)}</code></pre></li>`).join('');
    const refactorings = review.refactorings.suggestions.map(suggestion =>
      `<li><strong>${escapeHtml(suggestion.type)} / ${escapeHtml(suggestion.location)} / ${suggestion.impact} impact</strong>` +
      `<p>${escapeHtml(suggestion.description)}</p>` +
      `<h4>Before</h4><pre><code>${escapeHtml(suggestion.before)}</code></pre>` +
      `<h4>After</h4><pre><code>${escapeHtml(suggestion.after)}</code></pre>` +
      `<p><b>Benefits:</b> ${escapeHtml(suggestion.benefits)}</p></li>`).join('');
    const testFiles = review.testCoverage.testFiles.map(escapeHtml).join(', ') || 'None identified.';

    return `<section id="file-${index}"><h2>${escapeHtml(review.file)}</h2>` +
      `<p class="metrics">Quality ${review.codeQuality.overallScore}/100 ` +
      `<span>Static coverage estimate ${review.testCoverage.coverageEstimate}%</span></p>` +
      `<p>${escapeHtml(review.codeQuality.summary)}</p>` +
      `<h3>Quality Issues</h3><ul>${issues || '<li>No issues identified.</li>'}</ul>` +
      `<h3>Test Coverage</h3><p>${escapeHtml(review.testCoverage.summary)}</p><p>Existing tests: ${testFiles}</p>` +
      `<ul>${tests || '<li>No additional test gaps identified.</li>'}</ul>` +
      `<h3>Refactoring</h3><p>${escapeHtml(review.refactorings.summary)}</p>` +
      `<ul>${refactorings || '<li>No worthwhile refactoring identified.</li>'}</ul></section>`;
  }

  private htmlTrace(trace: readonly ExecutionTraceEvent[]): string {
    if (!trace.length) return '';
    const rows = toolUsageRows(trace).map(([actor, tools]) => `<tr><td>${escapeHtml(actor)}</td><td>${escapeHtml(tools)}</td></tr>`);
    return `<section id="execution-trace"><h2>Agent Execution Trace</h2><p class="note">${TRACE_NOTE}</p>` +
      `<table><thead><tr><th>Actor</th><th>Tool calls</th></tr></thead><tbody>${rows.join('')}</tbody></table>` +
      `<pre class="mermaid">${escapeHtml(buildSequenceDiagram(trace))}</pre></section>`;
  }
}

const HTML_STYLES = `
:root{--ink:#202623;--muted:#5b6560;--paper:#fff;--rule:#dbe2dd;--accent:#176348;--critical:#a12637;--high:#9b5900}
*{box-sizing:border-box}
body{margin:0;color:var(--ink);background:var(--paper);font-family:"Aptos","Segoe UI",sans-serif;font-size:16px;line-height:1.6}
main{max-width:1100px;margin:auto;padding:32px 24px}
header{border-bottom:3px solid var(--accent);padding-bottom:24px}
h1{font-size:32px;line-height:1.2;margin:0 0 12px}
h2{font-size:23px;line-height:1.3;overflow-wrap:anywhere}
h3{font-size:18px;margin-top:24px}
h4{font-size:15px;margin-bottom:8px}
p,small,strong{overflow-wrap:anywhere}
small,.note{color:var(--muted)}
section{border-top:1px solid var(--rule);padding:24px 0}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;padding:24px 0}
.summary b{display:block;font-size:26px;color:var(--accent)}
ul{list-style:none;padding:0}
li{border-left:3px solid var(--rule);padding:12px 16px;margin:12px 0;background:#f5f8f6}
.critical{border-color:var(--critical)}.high{border-color:var(--high)}.medium{border-color:#29769b}.low{border-color:var(--accent)}
li p{margin:8px 0}
.metrics{font-weight:600;display:flex;gap:24px;flex-wrap:wrap}
pre{background:#edf1ee;padding:16px;overflow:auto;max-width:100%;font-size:13px;line-height:1.5;border-radius:4px}
pre.mermaid{background:#fff;border:1px solid var(--rule)}
code{font-family:Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;margin:16px 0;font-size:14px}
th,td{border:1px solid var(--rule);padding:8px 12px;text-align:left;vertical-align:top}
footer{border-top:1px solid var(--rule);padding-top:24px;color:var(--muted);font-size:13px}
@media(max-width:600px){main{padding:20px 16px}h1{font-size:27px}h2{font-size:20px}li{padding:10px 12px}}
@media print{pre,li{break-inside:avoid}main{max-width:none}}
`;
