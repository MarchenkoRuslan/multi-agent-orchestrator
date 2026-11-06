import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ReviewReportSchema } from '../types/report-types.js';
import { formatError } from '../utils/error-handler.js';
import { evaluateReport, type CaseEvaluation } from './evaluate.js';
import { goldenDataset, type GoldenCase } from './golden-dataset.js';

const defaultReportsDir = fileURLToPath(new URL('../../reports', import.meta.url));

export const reportFileFor = (golden: GoldenCase): string =>
  `${golden.pullRequest.owner}_${golden.pullRequest.repo}_${golden.pullRequest.number}.json`;

/**
 * Evaluates the generated JSON reports in `reportsDir` against the golden dataset.
 * A missing or schema-invalid report fails its case.
 */
export async function runGoldenEvaluation(reportsDir = defaultReportsDir, dataset = goldenDataset): Promise<CaseEvaluation[]> {
  const results: CaseEvaluation[] = [];
  for (const golden of dataset) {
    const path = join(reportsDir, reportFileFor(golden));
    try {
      const report = ReviewReportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      results.push(evaluateReport(report, golden));
    } catch (error) {
      results.push({ caseId: golden.id, passed: false, checks: [{ name: 'load report', passed: false, detail: `${path}: ${formatError(error)}` }] });
    }
  }
  return results;
}

async function cli(): Promise<void> {
  const reportsDir = resolve(process.argv[2] ?? defaultReportsDir);
  const results = await runGoldenEvaluation(reportsDir);
  for (const result of results) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.caseId}`);
    for (const item of result.checks) console.log(`  ${item.passed ? '[x]' : '[ ]'} ${item.name} - ${item.detail}`);
  }
  const passed = results.filter(result => result.passed).length;
  console.log(`\n${passed}/${results.length} golden cases passed (reports: ${reportsDir})`);
  if (passed !== results.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch(error => {
    console.error(`Evaluation failed: ${formatError(error)}`);
    process.exitCode = 1;
  });
}
