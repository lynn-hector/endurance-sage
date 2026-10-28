import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const release = JSON.parse(readFileSync(join(rootDir, 'output/npm/manifest.json'), 'utf8'))
const projectId = process.env.DSH_SENTRY_GITLAB_PROJECT_ID ?? process.env.CI_PROJECT_ID
const registry = process.env.DSH_SENTRY_NPM_REGISTRY
  ?? (projectId ? `https://gitlab.yeastar.com/api/v4/projects/${projectId}/packages/npm/` : undefined)
const token = process.env.NODE_AUTH_TOKEN ?? process.env.GITLAB_TOKEN ?? process.env.CI_JOB_TOKEN
if (process.env.CI_COMMIT_TAG !== undefined && process.env.CI_COMMIT_TAG !== `v${release.version}`) {
  throw new Error(`Tag ${process.env.CI_COMMIT_TAG} does not match package version v${release.version}`)
}
if (registry === undefined) {
  throw new Error('Set DSH_SENTRY_NPM_REGISTRY or DSH_SENTRY_GITLAB_PROJECT_ID before publishing')
}
if (token === undefined) {
  throw new Error('Set NODE_AUTH_TOKEN, GITLAB_TOKEN, or CI_JOB_TOKEN before publishing')
}

const url = new URL(registry)
if (url.protocol !== 'https:') throw new Error('Package registry must use HTTPS')
const authPath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
const tempDir = mkdtempSync(join(tmpdir(), 'dsh-sentry-npm-'))
const userconfig = join(tempDir, '.npmrc')
writeFileSync(userconfig, [
  `@dsh-sentry:registry=${registry}`,
  `//${url.host}${authPath}:_authToken=${token}`,
  '',
].join('\n'), { mode: 0o600 })

try {
  const ordered = [...release.packages].sort((a, b) => Number(a.name === '@dsh-sentry/sentry') - Number(b.name === '@dsh-sentry/sentry'))
  for (const pkg of ordered) {
    process.stdout.write(`publishing ${pkg.name}@${pkg.version}\n`)
    const result = spawnSync('pnpm', [
      'publish', join(rootDir, pkg.tarball),
      '--registry', registry,
      `--config.userconfig=${userconfig}`,
      '--no-git-checks',
    ], { env: { ...process.env, CI: 'true' }, stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`Failed to publish ${pkg.name}@${pkg.version}`)
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
