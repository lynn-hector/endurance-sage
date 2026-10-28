import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const outputDir = join(rootDir, 'output/npm')
const version = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version
const packageDirs = readdirSync(join(rootDir, 'packages'), { withFileTypes: true })
  .flatMap(group => group.isDirectory()
    ? readdirSync(join(rootDir, 'packages', group.name), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(rootDir, 'packages', group.name, entry.name))
    : [])
  .filter(dir => existsSync(join(dir, 'package.json')))
  .sort()

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })
const packages = []
for (const dir of packageDirs) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const result = spawnSync('pnpm', ['pack', '--pack-destination', outputDir], {
    cwd: dir,
    env: { ...process.env, CI: 'true' },
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
  const filename = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
  const tarball = join(outputDir, filename)
  if (!existsSync(tarball)) throw new Error(`Expected tarball was not created: ${tarball}`)
  packages.push({ name: manifest.name, version, dir, tarball: `output/npm/${filename}` })
}
writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({ version, packages }, null, 2)}\n`)
process.stdout.write(`packed ${packages.length} packages at ${version} into output/npm\n`)
