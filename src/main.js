'use strict'

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const isDev = !app.isPackaged
const resourcesRoot = isDev
  ? path.join(__dirname, '..', 'resources')
  : process.resourcesPath

const isWindows = process.platform === 'win32'
const userNodeDir = path.join(app.getPath('userData'), 'node')
const runtimeDir = path.join(app.getPath('userData'), 'runtime')
const nodeArchive = path.join(resourcesRoot, 'node.tar.gz')
const runtimeArchive = path.join(resourcesRoot, 'runtime.tar.gz')
const bundledArchives = fs.existsSync(nodeArchive) && fs.existsSync(runtimeArchive)
const seedRuntimeDir = path.join(resourcesRoot, 'runtime')
const nodeBin = process.env.DSH_DESKTOP_NODE || (bundledArchives
  ? (isWindows ? path.join(userNodeDir, 'node.exe') : path.join(userNodeDir, 'bin', 'node'))
  : (isWindows ? path.join(resourcesRoot, 'node', 'node.exe') : path.join(resourcesRoot, 'node', 'bin', 'node')))
const npmCli = bundledArchives
  ? (isWindows
      ? path.join(userNodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join(userNodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  : (isWindows
      ? path.join(resourcesRoot, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join(resourcesRoot, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
const dshBin = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const profileTemplateDir = path.join(resourcesRoot, 'profile-web')
const dshHome = process.env.DSH_DESKTOP_HOME || path.join(os.homedir(), '.dsh')
const UPDATE_REGISTRY = process.env.DSH_UPDATE_REGISTRY || 'https://registry.npmjs.org/@deepseek-ai/dsh/latest'
const UPDATE_REGISTRY_FALLBACK = 'https://registry.npmmirror.com/@deepseek-ai/dsh/latest'

let mainWindow = null
let tray = null
let child = null
let quitting = false
let restartCount = 0
let loadedUrl = null
let updating = false

function ensurePluginInProfile(profileDir, pluginName) {
  const manifestPath = path.join(profileDir, 'package.json')
  if (!fs.existsSync(manifestPath)) return
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles
  if (!Array.isArray(bundles) || bundles.includes(pluginName)) return
  bundles.push(pluginName)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const src = path.join(profileTemplateDir, 'node_modules', pluginName)
  const dest = path.join(profileDir, 'node_modules', pluginName)
  if (fs.existsSync(src) && !fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(src, dest, { recursive: true })
  }
  console.log(`[dsh-desktop] added plugin ${pluginName} to existing web profile`)
}

function ensureDshHome() {
  fs.mkdirSync(dshHome, { recursive: true })
  const profileDir = path.join(dshHome, 'profiles', 'web')
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    fs.mkdirSync(path.dirname(profileDir), { recursive: true })
    fs.cpSync(profileTemplateDir, profileDir, { recursive: true })
    console.log('[dsh-desktop] initialized web profile at', profileDir)
  } else {
    ensurePluginInProfile(profileDir, 'dsh-codex')
    ensurePluginInProfile(profileDir, 'dsh-access-mode')
  }
}

function extractArchive(archive, dest) {
  return new Promise((resolve, reject) => {
    const tar = isWindows ? 'tar.exe' : 'tar'
    console.log(`[dsh-desktop] extracting ${path.basename(archive)} ...`)
    const proc = spawn(tar, ['-xzf', archive, '-C', dest, '--strip-components=1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let errText = ''
    proc.stdout.on('data', (buf) => process.stdout.write(`[extract] ${buf.toString()}`))
    proc.stderr.on('data', (buf) => {
      errText += buf.toString()
      process.stderr.write(`[extract] ${buf.toString()}`)
    })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar extract failed (${code}): ${errText.slice(-1000)}`))
    })
  })
}

async function ensureRuntime() {
  const marker = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const nodeMarker = isWindows
    ? path.join(userNodeDir, 'node.exe')
    : path.join(userNodeDir, 'bin', 'node')
  if (fs.existsSync(marker) && fs.existsSync(nodeMarker)) return
  console.log('[dsh-desktop] preparing runtime in user data (one-time, may take a while)...')
  fs.rmSync(runtimeDir, { recursive: true, force: true })
  fs.rmSync(userNodeDir, { recursive: true, force: true })
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.mkdirSync(userNodeDir, { recursive: true })
  if (bundledArchives) {
    await extractArchive(runtimeArchive, runtimeDir)
    await extractArchive(nodeArchive, userNodeDir)
  } else {
    await fs.promises.cp(seedRuntimeDir, runtimeDir, { recursive: true })
    const seedNodeDir = path.join(resourcesRoot, 'node')
    if (fs.existsSync(seedNodeDir)) {
      await fs.promises.cp(seedNodeDir, userNodeDir, { recursive: true })
    }
  }
  if (!isWindows) {
    try { fs.chmodSync(path.join(userNodeDir, 'bin', 'node'), 0o755) } catch {}
  }
  console.log('[dsh-desktop] runtime ready')
}

function currentDshVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    return pkg.version
  } catch {
    return 'unknown'
  }
}

function killChild() {
  if (!child) return
  try {
    if (isWindows && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
  } catch {}
  child = null
}

function startDsh() {
  if (quitting || updating) return
  if (!fs.existsSync(nodeBin) || !fs.existsSync(dshBin)) {
    showError(`运行时缺失\n\nNode: ${nodeBin}\nDSH: ${dshBin}`)
    return
  }
  loadedUrl = null
  const args = [dshBin, 'web', '--host', '127.0.0.1', '--port', '0']
  const env = { ...process.env, DSH_HOME: dshHome }
  console.log('[dsh-desktop] starting dsh web with', nodeBin)
  child = spawn(nodeBin, args, {
    env,
    cwd: os.homedir(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  console.log('[dsh-desktop] child pid', child.pid)

  let stdoutBuf = ''
  child.stdout.on('data', (buf) => {
    stdoutBuf += buf.toString()
    let index
    while ((index = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, index).replace(/\r$/, '')
      stdoutBuf = stdoutBuf.slice(index + 1)
      console.log('[dsh]', line)
      if (!loadedUrl) {
        const match = line.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
        if (match) {
          loadedUrl = match[1]
          console.log('[dsh-desktop] ready at', loadedUrl)
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(loadedUrl)
          }
        }
      }
    }
  })
  child.stderr.on('data', (buf) => {
    process.stderr.write(`[dsh] ${buf.toString()}`)
  })
  child.on('error', (err) => {
    console.error('[dsh-desktop] failed to spawn dsh:', err)
    showError(`无法启动 dsh：${err.message}`)
  })
  child.on('exit', (code, signal) => {
    console.log(`[dsh-desktop] dsh exited code=${code} signal=${signal}`)
    child = null
    if (quitting || updating) return
    if (restartCount < 3) {
      restartCount += 1
      console.log(`[dsh-desktop] restarting dsh (${restartCount}/3)`)
      setTimeout(startDsh, 1500)
    } else {
      showError('dsh 进程连续退出，请查看日志后重试。')
    }
  })
}

function showUpdating(version) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h2>DSH Desktop</h2><p>正在更新 DeepSeek Harness 到 ${version}，请稍候...</p></body>`
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

function showError(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h2>DSH Desktop</h2><pre style="white-space:pre-wrap">${message}</pre></body>`)}`)
}

async function fetchLatestVersion() {
  try {
    const res = await fetch(UPDATE_REGISTRY)
    if (!res.ok) throw new Error(`registry responded ${res.status}`)
    const data = await res.json()
    return data.version
  } catch {
    const res = await fetch(UPDATE_REGISTRY_FALLBACK)
    if (!res.ok) throw new Error(`fallback registry responded ${res.status}`)
    const data = await res.json()
    return data.version
  }
}

function runNpmInstall(version) {
  return new Promise((resolve, reject) => {
    const args = [
      npmCli, 'install', '--prefix', runtimeDir,
      '--omit=dev', '--no-audit', '--no-fund',
      `@deepseek-ai/dsh@${version}`,
    ]
    console.log('[dsh-desktop] running npm install for', version)
    const proc = spawn(nodeBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let errText = ''
    proc.stdout.on('data', (buf) => process.stdout.write(`[update] ${buf.toString()}`))
    proc.stderr.on('data', (buf) => {
      errText += buf.toString()
      process.stderr.write(`[update] ${buf.toString()}`)
    })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm install exited with code ${code}\n${errText.slice(-2000)}`))
    })
  })
}

async function performUpdate(version) {
  updating = true
  killChild()
  showUpdating(version)
  try {
    await runNpmInstall(version)
    console.log('[dsh-desktop] update to', version, 'completed')
    updating = false
    restartCount = 0
    startDsh()
  } catch (err) {
    console.error('[dsh-desktop] update failed:', err)
    updating = false
    showError(`更新失败：${err.message}`)
    restartCount = 0
    startDsh()
  }
}

async function checkForUpdates() {
  if (updating) return
  try {
    const latest = await fetchLatestVersion()
    const current = currentDshVersion()
    console.log(`[dsh-desktop] update check: current=${current} latest=${latest}`)
    if (latest === current || !mainWindow || mainWindow.isDestroyed()) return
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['更新', '暂不'],
      defaultId: 0,
      cancelId: 1,
      title: '发现新版本',
      message: 'DeepSeek Harness 有新版本',
      detail: `当前版本：${current}\n最新版本：${latest}\n\n更新会重新下载运行时依赖并重启 dsh。第三方插件可能与新版不完全兼容，是否更新？`,
    })
    if (choice.response === 0) await performUpdate(latest)
  } catch (err) {
    console.error('[dsh-desktop] update check failed:', err)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'DSH Desktop',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'loading.html'))
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) require('electron').shell.openExternal(url)
    return { action: 'deny' }
  })
}

function createTray() {
  const iconPath = path.join(resourcesRoot, 'icon.png')
  if (!fs.existsSync(iconPath)) return
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) return
  tray = new Tray(icon)
  tray.setToolTip('DSH Desktop')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus() } } },
    { label: '退出', click: () => { app.quit() } },
  ]))
  tray.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus() }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    ensureDshHome()
    createWindow()
    createTray()
    await ensureRuntime()
    startDsh()
    checkForUpdates()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    killChild()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
