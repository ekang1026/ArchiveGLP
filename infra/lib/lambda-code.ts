import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(LIB_DIR, '../../apps/api/dist');

/**
 * Inline placeholder that returns 501. Used ONLY in tests or when the
 * dist bundle is missing and CDK_REQUIRE_BUILT_LAMBDAS is not set. A
 * real `cdk deploy` must set that env var so a missing bundle fails
 * synth rather than deploying a non-functional Lambda.
 */
const PLACEHOLDER = lambda.Code.fromInline(
  "export const handler = async () => ({ statusCode: 501, body: 'not built: run pnpm --filter @archiveglp/api build' });",
);

/**
 * Resolve `apps/api/dist/<fn>` into a lambda.Code.
 *
 * - If the bundled index.mjs exists, use lambda.Code.fromAsset.
 * - If it's missing and CDK_REQUIRE_BUILT_LAMBDAS=1, throw (prod safety).
 * - If it's missing without the env var, emit PLACEHOLDER so `cdk synth`
 *   still works during tests without running `pnpm build` first.
 */
export function lambdaCodeFor(fnName: string): lambda.Code {
  const dir = path.join(DIST_ROOT, fnName);
  const entry = path.join(dir, 'index.mjs');
  if (!fs.existsSync(entry)) {
    if (process.env.CDK_REQUIRE_BUILT_LAMBDAS === '1') {
      throw new Error(
        `Lambda bundle missing: ${entry}\n` +
          `Run \`pnpm --filter @archiveglp/api build\` before \`cdk deploy\`.`,
      );
    }
    return PLACEHOLDER;
  }
  return lambda.Code.fromAsset(dir);
}
