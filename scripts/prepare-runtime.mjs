#!/usr/bin/env node
/**
 * Prepare the DSH Desktop runtime:
 * - install @deepseek-ai/dsh + plugin dependencies into resources/runtime
 * - copy dsh-codex and dsh-access-mode into resources/profile-web/node_modules
 * - download a standalone Node.js binary into resources/node
 *
 * Supports macOS (arm64/x64) and Windows (x64; arm64 when runner/arch available).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const resources = path.join(root, 'resources')
const runtimeDir = path.join(resources, 'runtime')
const profileDir = path.join(resources, 'profile-web')
const nodeDir = path.join(resources, 'node')

const isWindows = process.platform === 'win32'

function resolvePluginDir(name) {
  const candidates = [
    path.join(root, 'plugins', name),
    path.resolve(root, '..', name),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
  }
  throw new Error(`plugin source not found: ${name} (looked in ${candidates.join(', ')})`)
}

const pluginDirs = [
  resolvePluginDir('dsh-codex'),
  resolvePluginDir('dsh-access-mode'),
]

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function run(cmd, args, opts = {}) {
  const executable = isWindows && cmd === 'npm' ? 'npm.cmd' : cmd
  console.log(`[prepare] ${executable} ${args.join(' ')}`)
  const result = spawnSync(executable, args, {
    stdio: 'inherit',
    shell: isWindows && cmd === 'npm',
    ...opts,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
}

async function prepareRuntime() {
  // 1. runtime package.json: dsh + every dependency declared by the plugins.
  const pluginDeps = {}
  for (const dir of pluginDirs) {
    const pkg = readJson(path.join(dir, 'package.json'))
    if (pkg.dependencies) Object.assign(pluginDeps, pkg.dependencies)
  }
  const runtimePkg = {
    name: 'dsh-runtime',
    private: true,
    type: 'module',
    dependencies: {
      '@deepseek-ai/dsh': '0.1.0-rc.6',
      ...pluginDeps,
    },
  }
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n')
  console.log('[prepare] installing dsh runtime (this can take a few minutes)...')
  run('npm', ['install', '--prefix', runtimeDir, '--omit=dev', '--no-audit', '--no-fund'])

  // 2. profile-web template with the two plugins preinstalled.
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
  for (const dir of pluginDirs) {
    const pkg = readJson(path.join(dir, 'package.json'))
    const dest = path.join(profileDir, 'node_modules', pkg.name)
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of ['package.json', 'lib', 'src', 'scripts', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
      copyIfExists(path.join(dir, entry), path.join(dest, entry))
    }
    console.log(`[prepare] copied plugin ${pkg.name}`)
  }
  const profileManifest = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          'dsh-codex',
          'dsh-access-mode',
        ],
      },
    },
  }
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(profileManifest, null, 2) + '\n')
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
  fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

  // 3. standalone Node runtime (full distribution, includes npm for updates).
  const nodeBin = isWindows
    ? path.join(nodeDir, 'node.exe')
    : path.join(nodeDir, 'bin', 'node')
  const npmCli = isWindows
    ? path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!fs.existsSync(nodeBin) || !fs.existsSync(npmCli)) {
    await downloadNode(nodeDir)
  } else {
    console.log('[prepare] Node runtime already present')
  }
  console.log('[prepare] done')
}

async function downloadNode(nodeDir) {
  console.log('[prepare] downloading standalone Node.js...')
  const res = await fetch('https://nodejs.org/dist/index.json')
  if (!res.ok) throw new Error(`failed to fetch node index: ${res.status}`)
  const releases = await res.json()
  const release = releases.find((r) => r.version.startsWith('v24') && r.lts)
  if (!release) throw new Error('no Node 24 LTS release found')
  const version = release.version

  const platform = isWindows ? 'win' : 'darwin'
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch
  const ext = isWindows ? 'zip' : 'tar.gz'
  const archive = `node-${version}-${platform}-${arch}.${ext}`
  const url = `https://nodejs.org/dist/${version}/${archive}`
  const tmp = path.join(os.tmpdir(), archive)
  const extractDir = path.join(os.tmpdir(), `node-${version}-${platform}-${arch}`)

  console.log(`[prepare] downloading ${url}`)
  const dl = await fetch(url)
  if (!dl.ok) throw new Error(`failed to download node: ${dl.status}`)
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(tmp))

  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.mkdirSync(extractDir, { recursive: true })
  if (isWindows) {
    run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${tmp}' -DestinationPath '${extractDir}' -Force`])
  } else {
    run('tar', ['-xzf', tmp, '-C', extractDir, '--strip-components=1'])
  }

  fs.rmSync(nodeDir, { recursive: true, force: true })
  fs.mkdirSync(nodeDir, { recursive: true })
  if (isWindows) {
    const entries = fs.readdirSync(extractDir)
    const inner = entries.find((name) => name.startsWith('node-v'))
    if (!inner) throw new Error(`unexpected node archive layout in ${extractDir}`)
    fs.cpSync(path.join(extractDir, inner), nodeDir, { recursive: true })
  } else {
    fs.cpSync(extractDir, nodeDir, { recursive: true })
    fs.chmodSync(path.join(nodeDir, 'bin', 'node'), 0o755)
  }

  fs.rmSync(tmp, { force: true })
  fs.rmSync(extractDir, { recursive: true, force: true })
  console.log(`[prepare] Node ${version} ready`)
}

await prepareRuntime()
