import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import ts from 'typescript'

const formatHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => resolve('.'),
  getNewLine: () => ts.sys.newLine,
}

const packageDir = process.cwd()
const configPath = join(packageDir, 'tsconfig.json')
const config = ts.readConfigFile(configPath, ts.sys.readFile)
if (config.error !== undefined) {
  throw new Error(ts.formatDiagnostic(config.error, formatHost))
}

const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir)
const rootDir = join(packageDir, 'src')
const outDir = join(packageDir, 'dist')
const fileNames = parsed.fileNames.filter(file => file.startsWith(rootDir + sep))
if (fileNames.length === 0) throw new Error(`No source files found in ${rootDir}`)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const options = {
  ...parsed.options,
  rootDir,
  outDir,
  noEmit: false,
  noEmitOnError: true,
  rewriteRelativeImportExtensions: true,
  declaration: true,
  declarationMap: true,
  sourceMap: true,
}
const program = ts.createProgram(fileNames, options)
const emit = program.emit()
const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emit.diagnostics]
if (diagnostics.length > 0) {
  const host = {
    ...formatHost,
    getCurrentDirectory: () => packageDir,
  }
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host))
}
if (emit.emitSkipped || diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
  process.exit(1)
}

// Keep runtime resources beside the compiled modules. TypeScript emits only
// source files; persona Markdown and future package-local assets must travel.
cpSync(rootDir, outDir, {
  recursive: true,
  filter: source => source === rootDir || !source.endsWith('.ts'),
})

const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
process.stdout.write(`built ${manifest.name}\n`)
