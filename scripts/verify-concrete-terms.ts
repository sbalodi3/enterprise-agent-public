/** Reject one ambiguous origin label from maintained tracked files. */

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { historicalSchemaRegion } from './historical-schema-region.ts'

const root = resolve(import.meta.dirname, '..')
const blockedTerm = 'prove' + 'nance'
const excludedPrefixes = ['vendor/', '.agents/notes/archived/'] as const

// The pinned wage schema, SDK and existing document citations require these exact identifiers.
// Match only the binding at the start of a code line so adjacent authored text is still checked.
const wageFixtureField = new RegExp(String.raw`^\s*${blockedTerm}:\s*\{`, 'u')
const wagePartnerBindings = new Map<string, RegExp>([
  ['claims/domain/showcase.mjs', new RegExp(String.raw`^\s*const wageSource = artifact\?\.${blockedTerm}\b`, 'u')],
  ['claims/domain/tests/showcase.test.mjs', wageFixtureField],
  ['claims/showcase/data/data.test.mjs', wageFixtureField],
  ['claims/showcase/data/documents.mjs', new RegExp(
    String.raw`^\s*(?:const \{ data, ${blockedTerm}: wageSource \} = artifact\b|const wageSourceAnchorId = '${blockedTerm}')`, 'u',
  )],
  ['claims/showcase/partner/adapter.py', new RegExp(
    String.raw`^\s*(?:from sedgwick_a2a\.${blockedTerm} import Outcome\b|p = result\.${blockedTerm}\b|"${blockedTerm}":\s*\{)`, 'u',
  )],
  ['claims/showcase/partner/prepare.py', new RegExp(
    String.raw`^CLIENT = \("__init__", "agent_card", "client", "envelope", "errors", "jws", "${blockedTerm}"(?=, )`, 'u',
  )],
  ['claims/showcase/partner/test_partner.py', new RegExp(
    String.raw`^\s*(?:assert artifact\["${blockedTerm}"\]\["recordIds"\]|lambda body: artifact\(body\)\.pop\("${blockedTerm}"\))`, 'u',
  )],
  ['claims/showcase/partner/upstream.sha256', new RegExp(String.raw`^[0-9a-f]{64}  src/sedgwick_a2a/${blockedTerm}\.py$`, 'u')],
])

/** One blocked term occurrence in a tracked path or text line. */
export interface ConcreteTermViolation {
  /** Repository-relative tracked path. */
  file: string
  /** One-based source line, or null when the path contains the term. */
  line: number | null
}

function isExcluded(file: string): boolean {
  return excludedPrefixes.some(prefix => file.startsWith(prefix))
    // Supplied architecture decisions and their executive transcription retain their source wording.
    || (file.startsWith('sedgwick_info/ADR/') && file.endsWith('.md'))
    || file === 'sedgwick_info/sedgwick-enterprise-ai-architecture.md'
    // Release snapshots retain the identifiers present in their pinned source;
    // historical-format pairing records key sections by those identifiers' headings.
    || /^docs\/persistence-changes\/releases\/dsh-v\d+\.\d+\.\d+-(?:alpha|rc)\.\d+\.schema\.json$/u.test(file)
    || /^docs\/persistence-changes\/historical-formats\/v(?:0|[1-9]\d*)\.(?:schema\.json|i18n\.yaml)$/u.test(file)
}

function containsBlockedTerm(value: string): boolean {
  return value.normalize('NFKC').toLowerCase().includes(blockedTerm)
}

/**
 * Find the blocked term in one maintained tracked file.
 * @param file - repository-relative tracked path.
 * @param source - text contents or symlink target.
 * @returns violations in maintained text outside the preserved source and generated regions.
 */
export function findConcreteTermViolations(file: string, source: string): ConcreteTermViolation[] {
  if (isExcluded(file)) return []
  const violations: ConcreteTermViolation[] = []
  if (containsBlockedTerm(file)) violations.push({ file, line: null })
  const lines = source.split(/\r?\n/u)
  const schemaRegion = historicalSchemaRegion(file, source)
  const partnerBinding = wagePartnerBindings.get(file)
  for (const [index, line] of lines.entries()) {
    if (schemaRegion !== undefined && index >= schemaRegion[0] && index < schemaRegion[1]) continue
    if (containsBlockedTerm(partnerBinding ? line.replace(partnerBinding, '') : line)) {
      violations.push({ file, line: index + 1 })
    }
  }
  return violations
}

function trackedFiles(repoRoot: string): string[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\0')
    .filter(file => file !== '')
  if (!files.includes('AGENTS.md')
    || !files.some(file => file.startsWith('packages/'))
    || !files.some(file => file.startsWith('docs/'))
    || !files.some(file => file.startsWith('vendor/'))
    || !files.some(file => file.startsWith('.agents/notes/archived/'))) {
    throw new Error('verify-concrete-terms: tracked-file discovery omitted a required repository area')
  }
  return files
}

/**
 * Read one tracked file without following a symlink to its target.
 * @param repoRoot - Repository root containing the tracked path.
 * @param file - Repository-relative tracked path.
 * @returns File text, the symlink target, or undefined when the path is absent or not a file.
 */
export function readTrackedSource(repoRoot: string, file: string): string | undefined {
  const path = resolve(repoRoot, file)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return undefined
  if (stat.isSymbolicLink()) return readlinkSync(path)
  return stat.isFile() ? readFileSync(path, 'utf8') : undefined
}

function scanRepository(repoRoot: string): ConcreteTermViolation[] {
  const violations: ConcreteTermViolation[] = []
  for (const file of trackedFiles(repoRoot)) {
    const source = readTrackedSource(repoRoot, file)
    if (source === undefined) continue
    violations.push(...findConcreteTermViolations(file, source))
  }
  return violations
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const violations = scanRepository(root)
  if (violations.length === 0) {
    console.log('verify-concrete-terms: maintained terminology and external identifiers verified.')
  } else {
    console.error(`verify-concrete-terms: ${blockedTerm} is forbidden; name the exact source, field, identity, or evidence:`)
    for (const violation of violations) {
      console.error(violation.line === null
        ? `  ${violation.file} (path)`
        : `  ${violation.file}:${String(violation.line)}`)
    }
    process.exitCode = 1
  }
}
