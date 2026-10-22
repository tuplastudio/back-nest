import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Policy checks on the pipeline definition (BN-TASK-041/042/045/046/047/048).
 *
 * The workflows only run on GitHub, so their properties are asserted on the
 * files: a refactor that drops `needs: ci` or turns Trivy back into a report
 * fails here, in the pull request, instead of being noticed after a release.
 * `actionlint` checks syntax separately; this checks intent.
 */
const root = process.cwd();
/** File contents, or empty when absent, so a missing file fails its own test rather than the suite. */
const read = (path: string): string =>
  existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : '';

/** Text of one top-level job (`  name:` up to the next job at the same indent). */
function job(workflow: string, id: string): string {
  const start = workflow.search(new RegExp(`^  ${id}:\\s*$`, 'm'));
  if (start < 0) {
    return '';
  }
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {2}[a-z_][a-z0-9_-]*:\s*$/m);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

/** Lines of a workflow with comments removed, so prose cannot satisfy a check. */
const code = (path: string): string =>
  read(path)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('pipeline policy', () => {
  const ci = code('.github/workflows/ci.yml');
  const deploy = code('.github/workflows/deploy.yml');
  const env = code('.github/workflows/deploy-environment.yml');

  describe('BN-TASK-041: deploy is gated by CI', () => {
    it('ci.yml is a reusable workflow', () => {
      expect(ci).toMatch(/^ {2}workflow_call:/m);
    });

    it('deploy.yml calls CI and every deploy job needs it', () => {
      expect(job(deploy, 'ci')).toMatch(/uses: \.\/\.github\/workflows\/ci\.yml/);
      expect(job(deploy, 'ci')).toMatch(/secrets: inherit/);
      expect(job(deploy, 'deploy_staging')).toMatch(/needs: \[?ci\b/);
      expect(job(deploy, 'deploy_production')).toMatch(/needs: \[ci, deploy_staging\]/);
    });

    it('a script declares environment and branch protection, dry-run by default', () => {
      const script = read('scripts/github/protect-repo.sh');
      expect(script).toMatch(/environments\/production/);
      expect(script).toMatch(/reviewers/);
      expect(script).toMatch(/deployment-branch-policies/);
      expect(script).toMatch(/required_approving_review_count["']?:\s*1/);
      expect(script).toMatch(/APPLY=false/);
    });
  });

  describe('BN-TASK-042: tenant migrations run in the migrate Job', () => {
    it('the Job runs control-plane and tenant migrations', () => {
      expect(job(env, 'migrate')).toMatch(/db:migrate:all/);
      expect(read('Dockerfile')).toMatch(/db:migrate:all/);
      expect(read('package.json')).toMatch(
        /"db:migrate:all": "tsx scripts\/migrate\.ts && tsx scripts\/migrate-tenants\.ts"/,
      );
    });

    it('CI validates tenant migrations against the base branch and runs the integration test', () => {
      expect(ci).toMatch(/MIGRATIONS_BASE_REF/);
      expect(ci).toMatch(/npm run test:int/);
    });
  });

  describe('BN-TASK-045: tagged, gradual promotion with rollback', () => {
    it('deploys without traffic under an rc tag, in every environment', () => {
      const d = job(env, 'deploy');
      expect(d).toMatch(/--no-traffic/);
      expect(d).toMatch(/--tag="?\$TAG"?/);
      expect(d).toMatch(/TAG="rc-\$\{GITHUB_SHA::8\}"/);
      expect(d).not.toMatch(/if: inputs\.environment == 'staging'\n\s+id: deploy_traffic/);
    });

    it('smokes the tagged URL', () => {
      expect(job(env, 'deploy')).toMatch(/tag_url/);
      expect(job(env, 'smoke')).toMatch(/needs\.deploy\.outputs\.tag_url/);
    });

    it('moves traffic in steps, checking 5xx, and rolls back on failure', () => {
      const p = job(env, 'promote');
      expect(p).toMatch(/10 50 100/);
      expect(p).toMatch(/revision-error-rate\.sh/);
      expect(p).toMatch(/if: failure\(\)/);
      expect(p).toMatch(/--to-revisions="\$PREVIOUS=100"/);
      expect(p).not.toMatch(/if: \$\{\{ inputs\.environment == 'production' \}\}/);
    });
  });

  describe('BN-TASK-046: declared flags and drift check', () => {
    const flags = JSON.parse(read('.github/cloudrun/flags.json') || '{}') as Record<
      string,
      Record<string, string | number | boolean>
    >;

    it('deploy applies the declared flags', () => {
      expect(job(env, 'deploy')).toMatch(/cloudrun-flags\.sh args/);
      for (const environment of ['staging', 'production']) {
        const f = flags[environment];
        expect(f).toBeDefined();
        for (const key of [
          'minInstances',
          'maxInstances',
          'cpuThrottling',
          'ingress',
          'vpcEgress',
          'concurrency',
          'timeoutSeconds',
        ]) {
          expect(f).toHaveProperty(key);
        }
      }
    });

    it('a scheduled workflow checks drift', () => {
      const drift = code('.github/workflows/drift-check.yml');
      expect(drift).toMatch(/schedule:/);
      expect(drift).toMatch(/cloudrun-flags\.sh check/);
    });

    it('docs/DEPLOY-GCP.md states the same production values', () => {
      const docs = read('docs/DEPLOY-GCP.md');
      const p = flags['production'] ?? {};
      expect(docs).toContain('.github/cloudrun/flags.json');
      expect(docs).toMatch(new RegExp(`\`--min-instances\`\\s*\\|\\s*\`${String(p['minInstances'])}\``));
      expect(docs).toMatch(new RegExp(`\`--max-instances\`\\s*\\|\\s*\`${String(p['maxInstances'])}\``));
      expect(docs).toMatch(new RegExp(`\`--ingress\`\\s*\\|\\s*\`${String(p['ingress'])}\``));
      expect(docs).toMatch(new RegExp(`\`--vpc-egress\`\\s*\\|\\s*\`${String(p['vpcEgress'])}\``));
    });
  });

  describe('BN-TASK-047: blocking Trivy and registry retention', () => {
    it('Trivy fails CI on HIGH/CRITICAL, for the tree and the image', () => {
      const scan = job(ci, 'scan');
      expect(scan).toMatch(/severity: HIGH,CRITICAL/);
      expect(scan).toMatch(/exit-code: '1'/);
      expect(scan).toMatch(/scan-type: image/);
      // A first attempt may tolerate a failed scanner download; the retry may not.
      expect(scan).toMatch(/if: steps\.trivy_fs\.outcome == 'failure'/);
      expect(scan).toMatch(/if: steps\.trivy_image\.outcome == 'failure'/);
      expect(scan).not.toMatch(/^\s{4}continue-on-error: true/m);
    });

    it('a cleanup policy keeps the last 10 digests', () => {
      const policy = JSON.parse(read('scripts/gcp/artifact-cleanup-policy.json') || '[]') as Array<{
        action: { type: string };
        mostRecentVersions?: { keepCount: number };
      }>;
      expect(policy.find((p) => p.action.type === 'Keep')?.mostRecentVersions?.keepCount).toBe(10);
      expect(existsSync(join(root, 'scripts/gcp/apply-artifact-cleanup.sh'))).toBe(true);
    });
  });

  describe('BN-TASK-048: coverage gate on src/payments', () => {
    it('jest enforces a line threshold for src/payments', async () => {
      const config = (await import(join(root, 'jest.config.mjs'))) as {
        default: { coverageThreshold?: Record<string, { lines?: number }> };
      };
      expect(config.default.coverageThreshold?.['./src/payments/']?.lines).toBeGreaterThan(0);
    });
  });
});
