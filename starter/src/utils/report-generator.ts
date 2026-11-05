import { ReviewReportSchema, type ReviewReport } from '../types/report-types.js';

const html = (value: string): string => value.replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const markdown = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/([\\`*_{}\[\]()#+.!|])/g, '\\$1');
const codeBlock = (value: string): string => {
  const longest = Math.max(2, ...(value.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${value}\n${fence}`;
};

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
    const recommendations = report.recommendations.map((rec, index) =>
      `${index + 1}. **${rec.priority.toUpperCase()} / ${markdown(rec.category)}**: ${markdown(rec.description)}\n\nFiles: ${rec.files.map(markdown).join(', ')}`).join('\n\n');
    const files = report.fileReviews.map(review => {
      const issues = review.codeQuality.issues.map(issue =>
        `- **${issue.severity.toUpperCase()} | ${issue.category} | Line ${issue.line}**: ${markdown(issue.description)}\n\n  Fix: ${markdown(issue.suggestion)}`).join('\n\n');
      const tests = review.testCoverage.untestedPaths.map(path =>
        `- **${path.priority.toUpperCase()} | ${markdown(path.location)}**: ${markdown(path.reasoning)}\n\n${codeBlock(path.suggestedTest)}`).join('\n\n');
      const refactorings = review.refactorings.suggestions.map(suggestion =>
        `#### ${markdown(suggestion.type)}: ${markdown(suggestion.location)}\n\nImpact: ${suggestion.impact}\n\n${markdown(suggestion.description)}\n\nBefore:\n\n${codeBlock(suggestion.before)}\n\nAfter:\n\n${codeBlock(suggestion.after)}\n\nBenefits: ${markdown(suggestion.benefits)}`).join('\n\n');
      return `### ${markdown(review.file)}\n\nQuality: ${review.codeQuality.overallScore}/100 | Static coverage estimate: ${review.testCoverage.coverageEstimate}%\n\n${markdown(review.codeQuality.summary)}\n\n#### Quality Issues\n\n${issues || 'No issues identified.'}\n\n#### Test Coverage\n\n${markdown(review.testCoverage.summary)}\n\nExisting tests: ${review.testCoverage.testFiles.map(markdown).join(', ') || 'None identified.'}\n\n${tests || 'No additional test gaps identified.'}\n\n#### Refactoring\n\n${markdown(review.refactorings.summary)}\n\n${refactorings || 'No worthwhile refactoring identified.'}`;
    }).join('\n\n---\n\n');
    return `# DevFlow Code Review\n\n${markdown(pullRequest.owner)}/${markdown(pullRequest.repo)} | PR #${pullRequest.number}\n\n## Summary\n\n| Metric | Value |\n| --- | --- |\n| Overall quality score | ${summary.overallScore}/100 |\n| Files reviewed | ${summary.totalFiles} |\n| Critical issues | ${summary.criticalIssues} |\n| High-priority test gaps | ${summary.highPriorityTests} |\n| Refactoring opportunities | ${summary.refactoringOpportunities} |\n\nCoverage values are static estimates, not measured test coverage. A 100% value on a non-executable file is an N/A placeholder.\n\n## Recommendations\n\n${recommendations || 'No recommendations.'}\n\n## File Reviews\n\n${files || 'No changed files; overall score is not applicable.'}\n\n---\n\nAnalyzed at ${report.metadata.analyzedAt} | Duration: ${report.metadata.duration} ms\n\nAgents: ${Object.entries(report.metadata.agentVersions).map(([name, version]) => `${markdown(name)} (${markdown(version)})`).join(', ')}\n`;
  }

  /**
   * Generate an HTML report for web display
   */
  generateHTMLReport(report: ReviewReport): string {
    report = ReviewReportSchema.parse(report);
    const recommendations = report.recommendations.map(rec => `<li class="${rec.priority}"><strong>${rec.priority.toUpperCase()} / ${html(rec.category)}</strong><p>${html(rec.description)}</p><small>${rec.files.map(html).join(', ')}</small></li>`).join('');
    const files = report.fileReviews.map((review, index) => {
      const issues = review.codeQuality.issues.map(issue => `<li class="${issue.severity}"><strong>${issue.severity.toUpperCase()} / ${html(issue.category)} / Line ${issue.line}</strong><p>${html(issue.description)}</p><p><b>Fix:</b> ${html(issue.suggestion)}</p></li>`).join('');
      const tests = review.testCoverage.untestedPaths.map(path => `<li class="${path.priority}"><strong>${path.priority.toUpperCase()} / ${html(path.location)}</strong><p>${html(path.reasoning)}</p><pre><code>${html(path.suggestedTest)}</code></pre></li>`).join('');
      const refactorings = review.refactorings.suggestions.map(suggestion => `<li><strong>${html(suggestion.type)} / ${html(suggestion.location)} / ${suggestion.impact} impact</strong><p>${html(suggestion.description)}</p><h4>Before</h4><pre><code>${html(suggestion.before)}</code></pre><h4>After</h4><pre><code>${html(suggestion.after)}</code></pre><p><b>Benefits:</b> ${html(suggestion.benefits)}</p></li>`).join('');
      return `<section id="file-${index}"><h2>${html(review.file)}</h2><p class="metrics">Quality ${review.codeQuality.overallScore}/100 <span>Static coverage estimate ${review.testCoverage.coverageEstimate}%</span></p><p>${html(review.codeQuality.summary)}</p><h3>Quality Issues</h3><ul>${issues || '<li>No issues identified.</li>'}</ul><h3>Test Coverage</h3><p>${html(review.testCoverage.summary)}</p><p>Existing tests: ${review.testCoverage.testFiles.map(html).join(', ') || 'None identified.'}</p><ul>${tests || '<li>No additional test gaps identified.</li>'}</ul><h3>Refactoring</h3><p>${html(review.refactorings.summary)}</p><ul>${refactorings || '<li>No worthwhile refactoring identified.</li>'}</ul></section>`;
    }).join('');
    const { summary, pullRequest } = report;
    return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>DevFlow Review: PR #${pullRequest.number}</title>
<style>
:root{--ink:#202623;--muted:#5b6560;--paper:#fff;--rule:#dbe2dd;--accent:#176348;--critical:#a12637;--high:#9b5900}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--paper);font-family:"Aptos","Segoe UI",sans-serif;font-size:16px;line-height:1.6;letter-spacing:0}main{max-width:1100px;margin:auto;padding:32px 24px}header{border-bottom:3px solid var(--accent);padding-bottom:24px}h1{font-size:32px;line-height:1.2;margin:0 0 12px}h2{font-size:23px;line-height:1.3;overflow-wrap:anywhere}h3{font-size:18px;margin-top:24px}h4{font-size:15px;margin-bottom:8px}p,small,strong{overflow-wrap:anywhere}small,.note{color:var(--muted)}section{border-top:1px solid var(--rule);padding:24px 0}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;padding:24px 0}.summary b{display:block;font-size:26px;color:var(--accent)}ul{list-style:none;padding:0}li{border-left:3px solid var(--rule);padding:12px 16px;margin:12px 0;background:#f5f8f6}.critical{border-color:var(--critical)}.high{border-color:var(--high)}.medium{border-color:#29769b}.low{border-color:var(--accent)}li p{margin:8px 0}.metrics{font-weight:600;display:flex;gap:24px;flex-wrap:wrap}pre{background:#edf1ee;padding:16px;overflow:auto;max-width:100%;font-size:13px;line-height:1.5;border-radius:4px}code{font-family:Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}footer{border-top:1px solid var(--rule);padding-top:24px;color:var(--muted);font-size:13px}@media(max-width:600px){main{padding:20px 16px}h1{font-size:27px}h2{font-size:20px}li{padding:10px 12px}}@media print{pre,li{break-inside:avoid}main{max-width:none}}
</style></head><body><main><header><h1>DevFlow Code Review</h1><p>${html(pullRequest.owner)}/${html(pullRequest.repo)} <b>PR #${pullRequest.number}</b></p></header><div class="summary"><div><b>${summary.overallScore}/100</b>Overall quality</div><div><b>${summary.totalFiles}</b>Files reviewed</div><div><b>${summary.criticalIssues}</b>Critical issues</div><div><b>${summary.highPriorityTests}</b>High-priority test gaps</div><div><b>${summary.refactoringOpportunities}</b>Refactorings</div></div><p class="note">Coverage values are static estimates, not measured coverage. Non-executable files use 100% as an N/A placeholder.</p><h2>Recommendations</h2><ul>${recommendations || '<li>No recommendations.</li>'}</ul>${files || '<p>No changed files; overall score is not applicable.</p>'}<footer>Analyzed at ${html(report.metadata.analyzedAt)} | Duration: ${report.metadata.duration} ms<p>Agents: ${Object.entries(report.metadata.agentVersions).map(([name, version]) => `${html(name)} (${html(version)})`).join(', ')}</p></footer></main></body></html>`;
  }

  /**
   * Generate formatted JSON report
   */
  generateJSONReport(report: ReviewReport): string {
    return `${JSON.stringify(ReviewReportSchema.parse(report), null, 2)}\n`;
  }
}
