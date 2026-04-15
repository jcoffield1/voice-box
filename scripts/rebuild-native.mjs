/**
 * rebuild-native.mjs
 *
 * Ensures native Node addons are compiled for the correct runtime.
 *
 * Usage:
 *   node scripts/rebuild-native.mjs node      — rebuild for system Node (tests)
 *   node scripts/rebuild-native.mjs electron  — rebuild for Electron (dev/prod)
 *
 * The script reads the ABI baked into the existing better-sqlite3 binary and
 * skips the rebuild when the binary is already correct, so switching between
 * `npm test` and `npm run dev` only recompiles when actually necessary.
 */

import { execSync } from 'child_process'
import { createRequire } from 'module'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const require = createRequire(import.meta.url)

const target = process.argv[2] // 'node' | 'electron'
if (target !== 'node' && target !== 'electron') {
  console.error('Usage: rebuild-native.mjs <node|electron>')
  process.exit(1)
}

// ─── Step 1: Sign all .node files before any require() ─────────────────────
// After npm install, downloaded prebuilts may be unsigned. macOS Gatekeeper
// hangs dlopen() on unsigned binaries, so we sign everything before attempting
// to load the binary for ABI detection.
console.log('  → pre-signing .node binaries ...')
try {
  execSync(
    `find node_modules -name "*.node" | xargs -I{} codesign --sign - --force {}`,
    { cwd: root, stdio: 'pipe' }
  )
} catch {
  // non-fatal — codesign may not be available in CI
}

// ─── Determine the required ABI for each target ───────────────────────────────

const nodeAbi = process.versions.modules // ABI of the current system Node

let electronVersion
try {
  electronVersion = require(join(root, 'node_modules/electron/package.json')).version
} catch {
  electronVersion = null
}

let electronAbi = null
if (electronVersion) {
  try {
    const nodeAbiPkg = require(join(root, 'node_modules/node-abi'))
    electronAbi = nodeAbiPkg.getAbi(electronVersion, 'electron')
  } catch {
    // node-abi may not know about very new Electron releases — fall back to
    // extracting the ABI from the Electron binary itself via a quick exec.
    try {
      const electronBin = require(join(root, 'node_modules/electron')).toString().trim()
      const out = execSync(`"${electronBin}" --version 2>/dev/null || true`).toString().trim()
      console.log(`  Electron binary reports: ${out}`)
    } catch {
      // ignore
    }
    electronAbi = null
  }
}

const requiredAbi = target === 'electron' ? (electronAbi ?? 'unknown') : nodeAbi

// ─── Read the ABI the existing binary was compiled against ────────────────────

const binaryPath = join(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')

function detectBuiltAbi(_binPath) {
  // better-sqlite3 lazy-loads its native addon inside `new Database()`.
  // A plain `require('better-sqlite3')` always succeeds (returns the JS wrapper).
  // We must instantiate a Database to trigger the native load and catch any ABI
  // mismatch error. After the pre-signing step above this will NOT hang.
  try {
    const Module = require('better-sqlite3')
    new Module(':memory:').close() // triggers native addon dlopen()
    return String(nodeAbi)         // loaded OK → built for this nodeAbi
  } catch (e) {
    const m = e?.message?.match(/NODE_MODULE_VERSION (\d+)/)
    if (m) return m[1] // extract the binary's compiled ABI from the error
    return null
  }
}

const builtAbi = detectBuiltAbi(binaryPath)

console.log(`target: ${target}`)
console.log(`  system Node ABI : ${nodeAbi}`)
console.log(`  Electron version: ${electronVersion ?? 'n/a'}`)
console.log(`  Electron ABI    : ${electronAbi ?? 'n/a'}`)
console.log(`  binary ABI      : ${builtAbi ?? 'unknown'}`)
console.log(`  required ABI    : ${requiredAbi}`)

// ─── Decide whether a rebuild is needed ──────────────────────────────────────

if (builtAbi !== null && String(builtAbi) === String(requiredAbi)) {
  console.log('  ✓ binary already matches — skipping rebuild')
} else {
  if (target === 'electron') {
    console.log('  → electron-rebuild ...')
    execSync(
      'node node_modules/@electron/rebuild/lib/cli.js -f -w better-sqlite3,naudiodon',
      { cwd: root, stdio: 'inherit' }
    )
  } else {
    console.log('  → npm rebuild (system Node) ...')
    execSync('npm rebuild better-sqlite3 naudiodon', { cwd: root, stdio: 'inherit' })
  }
}

// ─── Always re-sign after any rebuild (rebuild replaces the binary) ──────────
console.log('  → signing .node binaries ...')
execSync(
  `find node_modules -name "*.node" | xargs -I{} codesign --sign - --force {}`,
  { cwd: root, stdio: 'inherit' }
)
console.log('  ✓ done')
