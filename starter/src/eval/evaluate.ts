import { LINE_TOLERANCE, type GoldenCase, type Severity } from './golden-dataset.js';
import type { ReviewReport } from '../types/report-types.js';

export interface EvaluationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface CaseEvaluation {
  caseId: string;
  passed: boolean;
  checks: EvaluationCheck[];
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const HIGH_PRIORITY = new Set(['critical', 'high']);

const check = (name: string, passed: boolean, detail: string): EvaluationCheck => ({ name, passed, detail });

/**
 * Scores one generated report against its golden expectations. Pure function: no I/O.
 */
export function evaluateReport(report: ReviewReport, golden: GoldenCase): CaseEvaluation {
  const checks: EvaluationCheck[] = [];
  const { owner, repo, number } = golden.pullRequest;
  const samePr = report.pullRequest.owner === owner && report.pullRequest.repo === repo && report.pullRequest.number === number;
  checks.push(check('identifies the pull request', samePr, `${report.pullRequest.owner}/${report.pullRequest.repo}#${report.pullRequest.number}`));

  const reviewed = report.fileReviews.map(review => review.file).sort();
  const expected = [...golden.expectedFiles].sort();
  checks.push(check('reviews exactly the changed files', JSON.stringify(reviewed) === JSON.stringify(expected), reviewed.join(', ')));

  const score = report.summary.overallScore;
  if (golden.minOverallScore !== undefined) {
    checks.push(check(`overall score >= ${golden.minOverallScore}`, score >= golden.minOverallScore, `score ${score}`));
  }
  if (golden.maxOverallScore !== undefined) {
    checks.push(check(`overall score <= ${golden.maxOverallScore}`, score <= golden.maxOverallScore, `score ${score}`));
  }
  if (golden.maxCriticalIssues !== undefined) {
    const critical = report.summary.criticalIssues;
    checks.push(check(`at most ${golden.maxCriticalIssues} critical issues`, critical <= golden.maxCriticalIssues, `${critical} critical`));
  }

  for (const expectedIssue of golden.requiredIssues ?? []) {
    const issues = report.fileReviews.filter(review => review.file === expectedIssue.file).flatMap(review => review.codeQuality.issues)
      .filter(issue => SEVERITY_RANK[issue.severity] >= SEVERITY_RANK[expectedIssue.minSeverity])
      .filter(issue => !expectedIssue.category || issue.category === expectedIssue.category)
      .filter(issue => expectedIssue.pattern.test(`${issue.description} ${issue.suggestion}`));
    const flagged = expectedIssue.lines.filter(line => issues.some(issue => Math.abs(issue.line - line) <= LINE_TOLERANCE));
    checks.push(check(
      `${expectedIssue.name} (${expectedIssue.minSeverity}+ at ${expectedIssue.minLinesFlagged}/${expectedIssue.lines.length} known lines)`,
      flagged.length >= expectedIssue.minLinesFlagged,
      `${issues.length} matching issue(s); flagged lines: ${flagged.join(', ') || 'none'}`
    ));
  }

  for (const gap of golden.requiredTestGaps ?? []) {
    const coverage = report.fileReviews.find(review => review.file === gap.file)?.testCoverage;
    const highPriority = coverage?.untestedPaths.filter(path => HIGH_PRIORITY.has(path.priority)) ?? [];
    const evidence = (coverage?.untestedPaths ?? []).map(path => `${path.location} ${path.reasoning}`).join('\n');
    const mentioned = gap.functions.filter(name => evidence.includes(name));
    checks.push(check(`${gap.name}: hasTests=${gap.hasTests}`, coverage?.hasTests === gap.hasTests, `hasTests=${coverage?.hasTests}`));
    checks.push(check(`${gap.name}: >= ${gap.minHighPriorityGaps} high-priority gaps`, highPriority.length >= gap.minHighPriorityGaps,
      `${highPriority.length} high/critical gap(s)`));
    checks.push(check(`${gap.name}: names >= ${gap.minMentioned} untested functions`, mentioned.length >= gap.minMentioned,
      mentioned.join(', ') || 'none'));
  }

  return { caseId: golden.id, passed: checks.every(item => item.passed), checks };
}
