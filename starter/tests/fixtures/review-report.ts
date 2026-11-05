export const validReport = {
  pullRequest: { owner: 'udacity', repo: 'cd14715-simple-todo-app', number: 2 },
  fileReviews: [{
    file: 'src/search.ts',
    codeQuality: { file: 'src/search.ts', issues: [{ line: 10, severity: 'high', category: 'bug-risk',
      description: 'Empty query rejects all results.', suggestion: 'Return all todos for an empty query.' }],
      overallScore: 85, summary: 'One search behavior defect.' },
    testCoverage: { file: 'src/search.ts', hasTests: false, testFiles: [], coverageEstimate: 0,
      untestedPaths: [{ type: 'edge-case', location: 'search:10', priority: 'high', reasoning: 'Empty input is common.',
        suggestedTest: 'expect(search(todos, "")).toEqual(todos)' }], summary: 'No search tests found; static estimate.' },
    refactorings: { file: 'src/search.ts', suggestions: [{ type: 'simplify', location: 'search:10', impact: 'low',
      description: 'Extract query normalization.', before: 'query.trim().toLowerCase()', after: 'normalizeQuery(query)',
      benefits: 'Centralizes normalization.' }], summary: 'One simplification.' }
  }],
  summary: { totalFiles: 1, overallScore: 85, criticalIssues: 0, highPriorityTests: 1, refactoringOpportunities: 1 },
  recommendations: [{ priority: 'high', category: 'testing', description: 'Test empty search queries.', files: ['src/search.ts'] }],
  metadata: { analyzedAt: '2026-11-05T00:00:00.000Z', duration: 100, agentVersions: { 'code-quality-analyzer': '1.0.0' } }
};