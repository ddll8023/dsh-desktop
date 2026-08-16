'use strict'

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron')
const { autoUpdater } = require('electron-updater')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const isDev = !app.isPackaged
const resourcesRoot = isDev
  ? path.join(__dirname, '..', 'resources')
  : process.resourcesPath

const isWindows = process.platform === 'win32'
const userDataRoot = app.getPath('userData')
const runtimeBundleRoot = path.join(userDataRoot, 'runtime-bundles')
const runtimeCurrentPath = path.join(runtimeBundleRoot, 'current.json')
const nodeArchive = path.join(resourcesRoot, 'node.tar.gz')
const runtimeArchive = path.join(resourcesRoot, 'runtime.tar.gz')
const runtimeManifestPath = path.join(resourcesRoot, 'runtime-manifest.json')
const bundledArchives = fs.existsSync(nodeArchive) && fs.existsSync(runtimeArchive)
const seedRuntimeDir = path.join(resourcesRoot, 'runtime')
const seedNodeDir = path.join(resourcesRoot, 'node')
const profileTemplateDir = path.join(resourcesRoot, 'profile-web')
const dshHome = process.env.DSH_DESKTOP_HOME || path.join(os.homedir(), '.dsh')

let runtimeDir = null
let nodeBin = null
let dshBin = null
let activeBundle = null
let mainWindow = null
let tray = null
let child = null
let quitting = false
let restartCount = 0
let loadedUrl = null
let updating = false
let updateDownloaded = false
let updatePromptShown = false
let pendingUpdateVersion = null

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n')
  try {
    fs.renameSync(temp, file)
  } catch (err) {
    if (!['EEXIST', 'EPERM'].includes(err.code)) throw err
    fs.rmSync(file, { force: true })
    fs.renameSync(temp, file)
  }
}

function manifestKey(manifest) {
  if (!manifest) return ''
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    desktopVersion: manifest.desktopVersion,
    dshVersion: manifest.dshVersion,
    nodeVersion: manifest.nodeVersion,
    plugins: manifest.plugins,
  })
}

function safeBundleId(manifest) {
  const releaseId = manifest.releaseId || `${manifest.desktopVersion}-${manifest.dshVersion}`
  return releaseId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180)
}

function bundlePaths(bundleDir) {
  return {
    runtime: path.join(bundleDir, 'runtime'),
    node: path.join(bundleDir, 'node'),
    manifest: path.join(bundleDir, 'manifest.json'),
  }
}

function activateBundle(bundleDir, manifest) {
  const paths = bundlePaths(bundleDir)
  activeBundle = { id: path.basename(bundleDir), dir: bundleDir, manifest }
  runtimeDir = paths.runtime
  nodeBin = process.env.DSH_DESKTOP_NODE || (isWindows
    ? path.join(paths.node, 'node.exe')
    : path.join(paths.node, 'bin', 'node'))
  dshBin = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function validateBundle(bundleDir, expectedManifest) {
  const paths = bundlePaths(bundleDir)
  const installedManifest = readJson(paths.manifest)
  const dshPackage = readJson(path.join(paths.runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const nodeMarker = isWindows ? path.join(paths.node, 'node.exe') : path.join(paths.node, 'bin', 'node')
  if (!installedManifest || manifestKey(installedManifest) !== manifestKey(expectedManifest)) return false
  if (!dshPackage || !fs.existsSync(nodeMarker)) return false
  if (expectedManifest.dshVersion !== 'unknown' && dshPackage.version !== expectedManifest.dshVersion) return false
  return fs.existsSync(path.join(paths.runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
}

function readBundledManifest() {
  const manifest = readJson(runtimeManifestPath)
  if (!manifest) throw new Error(`运行时 manifest 缺失：${runtimeManifestPath}`)
  return manifest
}

function ensurePluginInProfile(profileDir, pluginName) {
  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = readJson(manifestPath)
  if (!manifest) return
  const bundles = manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles
  if (!Array.isArray(bundles)) return

  let manifestChanged = false
  if (!bundles.includes(pluginName)) {
    bundles.push(pluginName)
    manifestChanged = true
  }

  const src = path.join(profileTemplateDir, 'node_modules', pluginName)
  const dest = path.join(profileDir, 'node_modules', pluginName)
  const sourcePackage = readJson(path.join(src, 'package.json'))
  const destPackage = readJson(path.join(dest, 'package.json'))
  const templateState = readJson(path.join(profileTemplateDir, '.dsh-desktop-profile-manifest.json'))
  const installedState = readJson(path.join(profileDir, '.dsh-desktop-profile-manifest.json'))
  const sourcePluginState = templateState && templateState.plugins && templateState.plugins[pluginName]
  const installedPluginState = installedState && installedState.plugins && installedState.plugins[pluginName]
  const revisionChanged = sourcePluginState && (!installedPluginState || sourcePluginState.revision !== installedPluginState.revision)
  const versionChanged = sourcePackage && (!destPackage || sourcePackage.version !== destPackage.version)
  const shouldSync = fs.existsSync(src) && (!destPackage || versionChanged || revisionChanged)

  if (shouldSync) {
    const temp = `${dest}.update-${process.pid}`
    fs.rmSync(temp, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(src, temp, { recursive: true })
    fs.rmSync(dest, { recursive: true, force: true })
    fs.renameSync(temp, dest)
    console.log(`[dsh-desktop] updated bundled plugin ${pluginName}`)
  }

  if (manifestChanged) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
  if (templateState && (!installedState || shouldSync)) {
    fs.writeFileSync(
      path.join(profileDir, '.dsh-desktop-profile-manifest.json'),
      JSON.stringify(templateState, null, 2) + '\n',
    )
  }
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

function loadCurrentBundle() {
  const pointer = readJson(runtimeCurrentPath)
  if (!pointer || !pointer.bundleId || pointer.bundleId !== path.basename(pointer.bundleId)) return null
  const bundleDir = path.join(runtimeBundleRoot, pointer.bundleId)
  const manifest = readJson(path.join(bundleDir, 'manifest.json'))
  if (!manifest || !validateBundle(bundleDir, manifest)) return null
  return { id: pointer.bundleId, dir: bundleDir, manifest }
}

async function prepareBundle(bundleDir, manifest) {
  const paths = bundlePaths(bundleDir)
  fs.mkdirSync(paths.runtime, { recursive: true })
  fs.mkdirSync(paths.node, { recursive: true })
  if (bundledArchives) {
    await extractArchive(runtimeArchive, paths.runtime)
    console.log('[dsh-desktop] runtime archive extracted')
    await extractArchive(nodeArchive, paths.node)
    console.log('[dsh-desktop] node archive extracted')
  } else {
    if (!fs.existsSync(seedRuntimeDir) || !fs.existsSync(seedNodeDir)) {
      throw new Error('开发模式运行时缺失，请先执行 npm run prepare:runtime')
    }
    await fs.promises.cp(seedRuntimeDir, paths.runtime, { recursive: true })
    await fs.promises.cp(seedNodeDir, paths.node, { recursive: true })
  }
  if (!isWindows) {
    try { fs.chmodSync(path.join(paths.node, 'bin', 'node'), 0o755) } catch {}
  }
  fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + '\n')
  if (!validateBundle(bundleDir, manifest)) {
    throw new Error('新 runtime 校验失败')
  }
}

function cleanupBundles() {
  if (!fs.existsSync(runtimeBundleRoot)) return
  const bundles = fs.readdirSync(runtimeBundleRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.staging-'))
    .map((entry) => {
      const dir = path.join(runtimeBundleRoot, entry.name)
      return { dir, mtime: fs.statSync(dir).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  for (const bundle of bundles.slice(2)) {
    fs.rmSync(bundle.dir, { recursive: true, force: true })
  }
}

async function ensureRuntime() {
  const expectedManifest = readBundledManifest()
  fs.mkdirSync(runtimeBundleRoot, { recursive: true })
  const current = loadCurrentBundle()
  if (current && manifestKey(current.manifest) === manifestKey(expectedManifest)) {
    activateBundle(current.dir, current.manifest)
    console.log(`[dsh-desktop] runtime ${expectedManifest.dshVersion} is ready`)
    return
  }

  const bundleId = safeBundleId(expectedManifest)
  const targetDir = path.join(runtimeBundleRoot, bundleId)
  if (validateBundle(targetDir, expectedManifest)) {
    writeJsonAtomic(runtimeCurrentPath, { schemaVersion: 1, bundleId })
    activateBundle(targetDir, expectedManifest)
    cleanupBundles()
    console.log(`[dsh-desktop] activated runtime bundle ${bundleId}`)
    return
  }

  const stagingDir = path.join(runtimeBundleRoot, `.staging-${process.pid}-${Date.now()}`)
  console.log(`[dsh-desktop] preparing runtime bundle ${bundleId} ...`)
  try {
    await prepareBundle(stagingDir, expectedManifest)
    fs.rmSync(targetDir, { recursive: true, force: true })
    fs.renameSync(stagingDir, targetDir)
    writeJsonAtomic(runtimeCurrentPath, { schemaVersion: 1, bundleId })
    activateBundle(targetDir, expectedManifest)
    cleanupBundles()
    console.log(`[dsh-desktop] runtime bundle ${bundleId} is ready`)
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true })
    if (current) {
      activateBundle(current.dir, current.manifest)
      console.error('[dsh-desktop] new runtime failed; using previous bundle:', err)
    } else {
      throw err
    }
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

function showUpdating(version, percent = null) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const progress = Number.isFinite(percent) ? `（${Math.round(percent)}%）` : ''
  mainWindow.setTitle(`DSH Desktop - 正在下载更新 ${version}${progress}`)
}

function restoreWindowTitle() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle('DSH Desktop')
}

function showError(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h2>DSH Desktop</h2><pre style="white-space:pre-wrap">${message}</pre></body>`)}`)
}

async function promptForUpdate(info) {
  if (updatePromptShown || updating || updateDownloaded || !mainWindow || mainWindow.isDestroyed()) return
  updatePromptShown = true
  try {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['下载更新', '暂不'],
      defaultId: 0,
      cancelId: 1,
      title: '发现新版本',
      message: 'DSH Desktop 有新版本',
      detail: `当前版本：${app.getVersion()}\n最新版本：${info.version}\n\n更新将替换整个桌面应用及内置运行时，用户数据不会被删除。下载完成后需要重启应用。`,
    })
    if (choice.response !== 0) return
    pendingUpdateVersion = info.version
    updating = true
    showUpdating(info.version)
    await autoUpdater.downloadUpdate()
  } catch (err) {
    updating = false
    restoreWindowTitle()
    console.error('[dsh-desktop] update download failed:', err)
    if (mainWindow && !mainWindow.isDestroyed()) {
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '更新失败',
        message: '无法下载新版本，请稍后重试。',
        detail: String(err && err.message ? err.message : err),
      })
    }
  } finally {
    updatePromptShown = false
  }
}

function setupAutoUpdater() {
  if (isDev) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => {
    console.log('[dsh-desktop] checking for desktop updates')
  })
  autoUpdater.on('update-available', (info) => {
    console.log('[dsh-desktop] desktop update available:', info.version)
    void promptForUpdate(info)
  })
  autoUpdater.on('update-not-available', (info) => {
    console.log('[dsh-desktop] desktop is up to date:', info.version)
  })
  autoUpdater.on('download-progress', (progress) => {
    showUpdating(pendingUpdateVersion || '新版本', progress.percent)
  })
  autoUpdater.on('update-downloaded', async (info) => {
    updating = false
    updateDownloaded = true
    restoreWindowTitle()
    if (!mainWindow || mainWindow.isDestroyed()) {
      quitting = true
      autoUpdater.quitAndInstall(false, true)
      return
    }
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '更新已下载',
      message: `DSH Desktop ${info.version} 已准备就绪`,
      detail: '立即重启将安装更新；选择“稍后”则会在下次退出应用时安装。',
    })
    if (choice.response === 0) {
      quitting = true
      autoUpdater.quitAndInstall(false, true)
    }
  })
  autoUpdater.on('error', (err) => {
    console.error('[dsh-desktop] desktop update error:', err)
    if (!updating) return
    updating = false
    restoreWindowTitle()
    if (mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '更新失败',
        message: '桌面端更新失败，请稍后重试。',
        detail: String(err && err.message ? err.message : err),
      })
    }
  })
}

async function checkForAppUpdates() {
  if (isDev || updating || updateDownloaded) return
  try {
    await autoUpdater.checkForUpdates()
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
    { label: '检查更新', click: () => { void checkForAppUpdates() } },
    { type: 'separator' },
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
    createWindow()
    createTray()
    await ensureRuntime()
    ensureDshHome()
    startDsh()
    setupAutoUpdater()
    setTimeout(() => { void checkForAppUpdates() }, 5000)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((err) => {
    console.error('[dsh-desktop] startup failed:', err)
    showError(`启动失败：${err.message || err}`)
  })

  app.on('before-quit', () => {
    quitting = true
    killChild()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
