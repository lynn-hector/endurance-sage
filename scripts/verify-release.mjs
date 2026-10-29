import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const release = JSON.parse(readFileSync(join(rootDir, 'output/npm/manifest.json'), 'utf8'))
for (const pkg of release.packages) {
  const tarball = join(rootDir, pkg.tarball)
  const files = read(tarball, ['-tf']).split('\n').filter(Boolean)
  for (const required of ['package/package.json', 'package/dist/index.js', 'package/dist/index.d.ts']) {
    if (!files.includes(required)) throw new Error(`${pkg.name} is missing ${required}`)
  }
  for (const forbidden of ['package/.env', 'package/.credentials.yaml']) {
    if (files.includes(forbidden)) throw new Error(`${pkg.name} contains forbidden file ${forbidden}`)
  }
  if (files.some(file => file.includes('/node_modules/') || file.startsWith('package/src/'))) {
    throw new Error(`${pkg.name} contains source-only or dependency files`)
  }
  if (pkg.name === '@dsh-sentry/env-matrix' && !files.includes('package/envs.yml')) {
    throw new Error('env-matrix tarball is missing envs.yml')
  }
  if (pkg.name === '@dsh-sentry/sentry-persona' && !files.includes('package/dist/persona.md')) {
    throw new Error('sentry-persona tarball is missing persona.md')
  }
  if (pkg.name === '@dsh-sentry/sentry-skills' && !files.includes('package/skills/project-context/SKILL.md')) {
    throw new Error('sentry-skills tarball is missing bundled skills')
  }
  if (pkg.name === '@dsh-sentry/sentry' && !files.includes('package/cordis.patch.yml')) {
    throw new Error('sentry bundle tarball is missing cordis.patch.yml')
  }
  if (pkg.name === '@dsh-sentry/sentry'
    && !['package/locale/en.json', 'package/locale/zh.json', 'package/icon.svg'].every(file => files.includes(file))) {
    throw new Error('sentry bundle tarball is missing its display metadata resources')
  }

  const manifest = JSON.parse(read(tarball, ['-xOf'], 'package/package.json'))
  if (manifest.version !== release.version || manifest.private === true) {
    throw new Error(`${pkg.name} has inconsistent version/privacy metadata`)
  }
  if (manifest.exports?.['.']?.default !== './dist/index.js') {
    throw new Error(`${pkg.name} does not export its compiled entry`)
  }
  // 宿主 readPluginMeta 通过 ESM 解析 <包名>/locale/<lang>.json 与 <包名>/package.json；
  // 未导出这两个子路径时 listPlugins 里该插件没有任何 meta。
  if (pkg.name === '@dsh-sentry/sentry'
    && (manifest.exports?.['./locale/*.json'] === undefined || manifest.exports?.['./package.json'] === undefined)) {
    throw new Error('sentry bundle does not export its display metadata resources')
  }
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (name.startsWith('@dsh-sentry/') && spec !== release.version) {
        throw new Error(`${pkg.name} has non-lockstep dependency ${name}@${spec}`)
      }
    }
  }
}
process.stdout.write(`verified ${release.packages.length} release tarballs at ${release.version}\n`)

function read(tarball, args, member) {
  const result = spawnSync('tar', [...args, tarball, ...(member ? [member] : [])], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `tar failed for ${tarball}`)
  return result.stdout
}
