import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Read and parse a JSON file from the package. */
function json(relative) {
  return JSON.parse(readFileSync(join(root, relative), 'utf8'))
}

const manifest = json('package.json')

test('the manifest names the package the bundles and routes refer to', () => {
  assert.equal(manifest.name, 'dsh-prompt-reforge')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.private, undefined, 'a publishable package must not be private')
})

test('the manifest declares the metadata the market reads', () => {
  assert.equal(manifest.license, 'MIT')
  assert.equal(typeof manifest.description, 'string')
  assert.ok(manifest.description.length > 0)
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.includes('dsh-plugin'))
  assert.match(manifest.repository.url, /^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/)
  assert.match(manifest.bugs.url, /\/issues$/)
  assert.match(manifest.homepage, /#readme$/)
  assert.equal(manifest.publishConfig.access, 'public')
})

/** The supported host line, kept in one place so manifest and docs agree. */
const HOST_RANGE = '>=0.2.1-rc.1 <0.3.0-0 || >=0.2.2-0 <0.3.0-0'

test('the host compatibility range is a plain, parseable range', () => {
  // `dshmarket` reads both spellings and prefers the top-level one; keep one.
  assert.equal(typeof manifest.engines.dsh, 'string')
  assert.ok(manifest.engines.dsh.length <= 256)
  assert.equal(manifest.dsh.engines, undefined, 'do not declare the range twice')
  // Plain ranges do not match their own prereleases, so the range needs an
  // explicit `||` branch to accept hosts like 0.2.2-rc.1. Spelling it out in
  // full makes a silent downgrade to the naive form fail here.
  assert.equal(manifest.engines.dsh, HOST_RANGE)
})

test('every declared peer is a harness package and marked optional', () => {
  const peers = Object.keys(manifest.peerDependencies)
  assert.ok(peers.length > 0)
  for (const name of peers) {
    assert.match(name, /^@deepseek-ai\//, `${name} must be a harness package`)
    assert.equal(manifest.peerDependenciesMeta[name]?.optional, true, `${name} must be optional`)
    // Peers and engines describe the same host line; drift between them would
    // make `pnpm` and `dshmarket` disagree about whether a host is supported.
    assert.equal(manifest.peerDependencies[name], HOST_RANGE, `${name} must track the host range`)
  }
})

test('the bundle points at a patch file that registers exactly one row', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const ids = [...patch.matchAll(/^\s*(?:-\s*)?id:\s*(\S+)\s*$/gm)].map((match) => match[1])
  const names = [...patch.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map((match) => match[1])
  assert.deepEqual(ids, ['prompt-reforge'])
  assert.deepEqual(names, ['dsh-prompt-reforge'])
})

test('the client declaration matches what the bundle actually exports', () => {
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.ok(Array.isArray(manifest.dsh.client.inject))

  const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
  const id = /load\(\{\s*id:\s*'([^']+)'/.exec(source)?.[1]
  assert.equal(id, manifest.name, 'the module loader id must be the package name')
})

test('every entry in `files` exists and the root holds no unexplained files', () => {
  for (const entry of manifest.files) {
    assert.doesNotThrow(() => statSync(join(root, entry)), `${entry} is listed in files but missing`)
  }

  // Files that live in the repository but are deliberately kept out of the
  // published tarball: tests, repository plumbing, and anything npm adds on
  // its own.
  const repoOnly = new Set([
    'test',
    'node_modules',
    '.git',
    '.github',
    '.gitignore',
    '.gitattributes',
    'pnpm-lock.yaml',
    'package-lock.json',
  ])
  // Only the first path segment is compared: `files` may ship a directory or a
  // single file nested inside one (`docs/README.zh.md`).
  const shipped = new Set(['package.json', ...manifest.files.map((entry) => entry.split('/')[0])])

  for (const name of readdirSync(root)) {
    if (repoOnly.has(name)) continue
    // A tarball left behind by `npm pack` is a build artifact, not a source file.
    if (name.endsWith('.tgz')) continue
    assert.ok(shipped.has(name), `${name} is in the package root but not shipped or ignored`)
  }
})

test('both locale dictionaries carry the metadata the plugin list renders', () => {
  for (const language of ['en', 'zh']) {
    const dictionary = json(`locale/${language}.json`)
    assert.equal(typeof dictionary.meta?.title, 'string')
    assert.ok(dictionary.meta.title.length > 0, `${language} title is empty`)
    assert.equal(typeof dictionary.meta?.description, 'string')
    assert.ok(dictionary.meta.description.length > 0, `${language} description is empty`)
  }
})

test('the license file is MIT and names the copyright holder', () => {
  const license = readFileSync(join(root, 'LICENSE'), 'utf8')
  assert.match(license, /MIT License/)
  assert.match(license, /Copyright \(c\) \d{4} Cloud017/)
})

test('the package carries no machine-specific paths or credentials', () => {
  // Patterns are assembled from fragments so this file does not match itself;
  // the tests live in the repository and must be clean too.
  const drive = '[A-Za-z]:'
  const sep = String.raw`\\`
  const forbidden = [
    new RegExp(`${drive}${sep}Users${sep}`, 'i'), // a Windows home directory
    new RegExp(`${drive}${sep}[^${sep}]+${sep}(?:AppData|Documents|Desktop)${sep}`, 'i'),
    /[\\/](?:home|Users)[\\/][A-Za-z0-9._-]+[\\/]/, // a POSIX home directory
    /\bghp_[A-Za-z0-9]{20,}/, // GitHub tokens
    /\bnpm_[A-Za-z0-9]{20,}/, // npm tokens
    /\bsk-[A-Za-z0-9]{20,}/, // provider API keys
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ]

  /** Walk every shipped text file. */
  function* walk(directory) {
    for (const name of readdirSync(directory)) {
      if (name === 'node_modules' || name === '.git') continue
      const path = join(directory, name)
      if (statSync(path).isDirectory()) {
        yield* walk(path)
        continue
      }
      if (!/\.(?:js|mjs|json|md|yml|svg|txt)$/i.test(name)) continue
      yield path
    }
  }

  for (const path of walk(root)) {
    const text = readFileSync(path, 'utf8')
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${path} leaks ${pattern}`)
    }
  }
})
