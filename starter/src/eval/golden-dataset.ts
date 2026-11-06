import type { ReviewReport } from '../types/report-types.js';

type CodeIssue = ReviewReport['fileReviews'][number]['codeQuality']['issues'][number];
export type Severity = CodeIssue['severity'];

/** A known defect the reviewers must report. */
export interface ExpectedIssue {
  name: string;
  file: string;
  category?: CodeIssue['category'];
  minSeverity: Severity;
  /** Must match the issue description or suggestion. */
  pattern: RegExp;
  /** Ground-truth defect lines; an issue counts when reported within `lineTolerance` of one of them. */
  lines: number[];
  /** Minimum number of distinct ground-truth lines that must be flagged. */
  minLinesFlagged: number;
}

/** A known testing gap the test-coverage analyzer must report. */
export interface ExpectedTestGap {
  name: string;
  file: string;
  hasTests: boolean;
  minHighPriorityGaps: number;
  /** Untested functions; at least `minMentioned` of them must appear in the untested-path locations or reasoning. */
  functions: string[];
  minMentioned: number;
}

export interface GoldenCase {
  id: string;
  description: string;
  pullRequest: ReviewReport['pullRequest'];
  expectedFiles: string[];
  minOverallScore?: number;
  maxOverallScore?: number;
  maxCriticalIssues?: number;
  requiredIssues?: ExpectedIssue[];
  requiredTestGaps?: ExpectedTestGap[];
}

export const LINE_TOLERANCE = 3;

const repository = { owner: 'udacity', repo: 'cd14715-simple-todo-app' };

/**
 * Golden dataset: snapshots of the three assignment PRs with defects verified by hand against the PR head commits.
 */
export const goldenDataset: GoldenCase[] = [
  {
    id: 'pr1-clean-code-control',
    description: 'Well-structured TypeScript fixture; a control case that must not produce false critical findings.',
    pullRequest: { ...repository, number: 1 },
    expectedFiles: ['fixtures/clean-code.ts'],
    minOverallScore: 70,
    maxCriticalIssues: 0
  },
  {
    id: 'pr2-sql-injection',
    description: 'Search helpers interpolate user input into SQL (searchTodos, searchTodosByStatus, getTodosByUser).',
    pullRequest: { ...repository, number: 2 },
    expectedFiles: ['src/todo.ts'],
    maxOverallScore: 75,
    requiredIssues: [{
      name: 'SQL injection in string-built queries',
      file: 'src/todo.ts',
      category: 'security',
      minSeverity: 'high',
      pattern: /sql\s*injection|parameteri[sz]ed|unsanitized|interpolat/i,
      lines: [121, 132, 143],
      minLinesFlagged: 2
    }]
  },
  {
    id: 'pr3-untested-payment-logic',
    description: 'New premium/payment module (payment processing, validation, pricing) ships without any tests.',
    pullRequest: { ...repository, number: 3 },
    expectedFiles: ['src/premium.ts'],
    requiredTestGaps: [{
      name: 'Untested payment and subscription logic',
      file: 'src/premium.ts',
      hasTests: false,
      minHighPriorityGaps: 2,
      functions: ['processPremiumPayment', 'validatePaymentDetails', 'calculateSubscriptionPrice', 'chargeCard', 'hasFeatureAccess'],
      minMentioned: 3
    }]
  }
];
