#!/usr/bin/env node
// DSH Desktop macOS 免签名更新安装器（纯 Node，无第三方依赖）
//
// 由主进程以 ELECTRON_RUN_AS_NODE=1 方式用自身 Electron 二进制运行：
//   <Electron 二进制> update-helper.js <request.json>
//
// request.json 字段：
//   zip       更新包（ZIP，electron-builder mac zip target 产物）绝对路径
//   version   目标版本（如 0.1.0）
//   resultFile 安装结果写入路径（JSON）
//   appRoot   当前 .app 绝对路径（本机安装位置）
//   parentPid 主进程 pid（helper 等待其退出后再替换）
//   skipOpen  测试模式：true 时不执行 `open` 重启
//
// 流程：等待主进程退出 → 校验 ZIP 条目无路径逃逸 → ditto 解压 →
//       校验 BundleId 与版本 → 原子替换（不可写目录走 osascript 授权）→
//       失败回滚 → 写结果文件 → open 重启 → 按保留期清理旧下载/备份
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const EXPECTED_BUNDLE_ID = 'com.dsh.desktop'
const PARENT_WAIT_TIMEOUT_MS = 180000
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 下载包/备份保留 7 天

function log(message) {
  console.log(`[dsh-update] ${message}`)
}

function fail(message) {
  console.error(`[dsh-update] ${message}`)
  process.exitCode = 1
  return null
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// ---------- 请求读取 ----------

function readRequest(requestFile) {
  let request
  try {
    request = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
  } catch (err) {
    throw new Error(`无法读取安装请求 ${requestFile}: ${err.message}`)
  }
  for (const key of ['zip', 'version', 'resultFile', 'appRoot']) {
    if (typeof request[key] !== 'string' || request[key].length === 0) {
      throw new Error(`安装请求缺少字段 ${key}`)
    }
  }
  if (!fs.existsSync(request.zip)) throw new Error(`更新包不存在：${request.zip}`)
  if (!fs.existsSync(request.appRoot)) throw new Error(`应用不存在：${request.appRoot}`)
  return request
}

// ---------- 等待主进程退出 ----------

function waitForParentExit(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  log(`等待主进程 ${pid} 退出 ...`)
  const start = Date.now()
  while (Date.now() - start < PARENT_WAIT_TIMEOUT_MS) {
    try {
      process.kill(pid, 0)
    } catch (err) {
      if (err.code === 'ESRCH') {
        sleepSync(2000) // 留出文件句柄释放时间
        log('主进程已退出，继续安装')
        return
      }
    }
    sleepSync(500)
  }
  throw new Error(`等待主进程退出超时（${PARENT_WAIT_TIMEOUT_MS / 1000}s）`)
}

// ---------- ZIP 条目校验（防路径逃逸） ----------

function readZipEntries(zipPath) {
  const fd = fs.openSync(zipPath, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size < 22) throw new Error('更新包损坏：文件过小')

    // 定位 EOCD（最后 65557 字节内搜索签名 0x06054b50）
    const tailLen = Math.min(size, 65557)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    }
    if (eocd === -1) throw new Error('更新包损坏：未找到 EOCD')

    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (count === 0) throw new Error('更新包损坏：空压缩包')
    if (cdOffset + cdSize > size) throw new Error('更新包损坏：中央目录越界')

    const cd = Buffer.alloc(cdSize)
    fs.readSync(fd, cd, 0, cdSize, cdOffset)
    const entries = []
    let offset = 0
    for (let i = 0; i < count; i++) {
      if (offset + 46 > cd.length || cd.readUInt32LE(offset) !== 0x02014b50) {
        throw new Error('更新包损坏：中央目录条目异常')
      }
      const nameLen = cd.readUInt16LE(offset + 28)
      const extraLen = cd.readUInt16LE(offset + 30)
      const commentLen = cd.readUInt16LE(offset + 32)
      if (offset + 46 + nameLen > cd.length) throw new Error('更新包损坏：条目名越界')
      entries.push(cd.toString('utf8', offset + 46, offset + 46 + nameLen))
      offset += 46 + nameLen + extraLen + commentLen
    }
    return entries
  } finally {
    fs.closeSync(fd)
  }
}

function validateEntriesAndFindApp(entries) {
  if (entries.length === 0) throw new Error('更新包损坏：无条目')
  const topApps = new Set()
  for (const raw of entries) {
    if (raw.includes('\\') || raw.includes(':')) throw new Error(`更新包含非法路径：${raw}`)
    if (raw.startsWith('/')) throw new Error(`更新包含绝对路径：${raw}`)
    const parts = raw.split('/')
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '..') throw new Error(`更新包含路径逃逸：${raw}`)
      if (parts[i] === '' && i !== parts.length - 1) throw new Error(`更新包含空路径段：${raw}`)
    }
    const match = /^([^/]+\.app)\//.exec(raw)
    if (match) topApps.add(match[1])
  }
  if (topApps.size !== 1) {
    throw new Error(`更新包必须且只能包含一个 .app，实际包含：${[...topApps].join(', ') || '无'}`)
  }
  return [...topApps][0]
}

// ---------- 解压与校验 ----------

function extractWithDitto(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const result = spawnSync('ditto', ['-x', '-k', zipPath, destDir], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`ditto 解压失败（${result.status}）：${String(result.stderr || '').slice(-500)}`)
  }
}

function readInfoPlist(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist')
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`无法读取 Info.plist：${plist}`)
  return JSON.parse(result.stdout)
}

function verifyApp(appPath, expectedVersion) {
  let info
  try {
    info = readInfoPlist(appPath)
  } catch (err) {
    throw new Error(`应用校验失败：${err.message}`)
  }
  if (info.CFBundleIdentifier !== EXPECTED_BUNDLE_ID) {
    throw new Error(`应用标识不匹配：${info.CFBundleIdentifier}（期望 ${EXPECTED_BUNDLE_ID}）`)
  }
  if (info.CFBundleShortVersionString !== expectedVersion) {
    throw new Error(`应用版本不匹配：${info.CFBundleShortVersionString}（期望 ${expectedVersion}）`)
  }
  const executable = path.join(appPath, 'Contents', 'MacOS', info.CFBundleExecutable || '')
  if (!fs.existsSync(executable)) throw new Error(`可执行文件缺失：${executable}`)
  return info
}

// ---------- 原子替换 ----------

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function privilegedReplace(appRoot, stagedApp, executableName) {
  const backupDir = path.join(path.dirname(appRoot), `.${path.basename(appRoot)}.dsh-backup-${Date.now()}`)
  const script = [
    `BACKUP=${shellQuote(backupDir)}`,
    `APP=${shellQuote(appRoot)}`,
    `STAGED=${shellQuote(stagedApp)}`,
    `EXEC=${shellQuote(path.join('Contents', 'MacOS', executableName))}`,
    `rm -rf "$BACKUP"`,
    `if [ -d "$APP" ]; then mv "$APP" "$BACKUP"; fi`,
    `ditto ${shellQuote(stagedApp)} "$APP"`,
    `if [ ! -x "$APP/$EXEC" ]; then rm -rf "$APP"; mv "$BACKUP" "$APP"; exit 1; fi`,
    `rm -rf "$BACKUP"`,
  ].join('; ')
  const result = spawnSync(
    '/usr/bin/osascript',
    ['-e', `do shell script ${shellQuote(script)} with administrator privileges`],
    { encoding: 'utf8', timeout: 300000 },
  )
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(-500)
    throw new Error(`授权安装被拒绝或失败（${result.status}）：${detail}`)
  }
}

function regularReplace(appRoot, stagedApp, expectedVersion) {
  const parentDir = path.dirname(appRoot)
  const base = path.basename(appRoot)
  const backupDir = path.join(parentDir, `.${base}.dsh-backup-${Date.now()}`)
  fs.renameSync(appRoot, backupDir)
  try {
    fs.renameSync(stagedApp, appRoot)
    verifyApp(appRoot, expectedVersion)
  } catch (err) {
    log(`替换失败，回滚：${err.message}`)
    fs.rmSync(appRoot, { recursive: true, force: true })
    fs.renameSync(backupDir, appRoot)
    throw err
  }
  fs.rmSync(backupDir, { recursive: true, force: true })
}

// ---------- 清理（保留期） ----------

function cleanupOldArtifacts(updatesDir, stagingRoot) {
  const now = Date.now()
  for (const dir of [updatesDir, stagingRoot]) {
    if (!dir || !fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!/^\.?dsh-(staging|backup)/.test(entry.name) && !/^staging-/.test(entry.name)) continue
      const target = path.join(dir, entry.name)
      try {
        const stat = fs.statSync(target)
        if (now - stat.mtimeMs > RETENTION_MS) {
          fs.rmSync(target, { recursive: true, force: true })
          log(`清理过期目录 ${target}`)
        }
      } catch {}
    }
  }
}

// ---------- 主流程 ----------

function main() {
  const requestFile = process.argv[2]
  if (!requestFile) {
    fail('用法：update-helper.js <request.json>')
    return
  }

  const updatesDir = path.dirname(requestFile)
  let request
  try {
    request = readRequest(requestFile)
  } catch (err) {
    console.error(`[dsh-update] ${err.message}`)
    process.exitCode = 1
    return
  }

  const appRoot = request.appRoot
  const version = request.version
  const resultFile = request.resultFile
  const skipOpen = request.skipOpen === true
  const stagingRoot = path.join(updatesDir, 'staging')
  const privileged = (() => {
    try {
      fs.accessSync(path.dirname(appRoot), fs.constants.W_OK)
      return false
    } catch {
      return true
    }
  })()

  const writeResult = (result) => {
    try {
      fs.mkdirSync(path.dirname(resultFile), { recursive: true })
      fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n')
    } catch (err) {
      console.error(`[dsh-update] 无法写入结果文件：${err.message}`)
    }
  }

  // staging 与目标 .app 同卷：可写目录直接放旁边（rename 原子）；不可写目录先解压到用户区再由授权进程复制
  const stagingDir = privileged
    ? path.join(stagingRoot, `staging-${process.pid}-${Date.now()}`)
    : path.join(path.dirname(appRoot), `.${path.basename(appRoot)}.dsh-staging-${process.pid}-${Date.now()}`)

  try {
    log(`开始安装 ${version}（目标 ${appRoot}${privileged ? '，需要管理员授权' : ''}）`)
    waitForParentExit(request.parentPid)

    cleanupOldArtifacts(updatesDir, path.dirname(appRoot))

    log('校验更新包条目 ...')
    const appName = validateEntriesAndFindApp(readZipEntries(request.zip))
    log(`更新包包含 ${appName}`)

    fs.rmSync(stagingDir, { recursive: true, force: true })

    log('解压更新包 ...')
    extractWithDitto(request.zip, stagingDir)
    const stagedApp = path.join(stagingDir, appName)
    if (!fs.existsSync(stagedApp)) throw new Error(`解压后缺少 ${appName}`)

    log('校验应用标识与版本 ...')
    const info = verifyApp(stagedApp, version)

    log('原子替换应用 ...')
    if (privileged) {
      privilegedReplace(appRoot, stagedApp, info.CFBundleExecutable)
    } else {
      regularReplace(appRoot, stagedApp, version)
    }
    verifyApp(appRoot, version)

    writeResult({ ok: true, version, appRoot, installedAt: new Date().toISOString() })
    log(`安装完成：${version}`)

    fs.rmSync(stagingDir, { recursive: true, force: true })
    try { fs.rmSync(request.zip, { force: true }) } catch {}

    if (!skipOpen) {
      log(`重启 ${appRoot}`)
      spawnSync('open', [appRoot], { stdio: 'ignore' })
    }
  } catch (err) {
    console.error(`[dsh-update] 安装失败：${err.message}`)
    fs.rmSync(stagingDir, { recursive: true, force: true })
    writeResult({ ok: false, version, error: String(err.message || err), installedAt: new Date().toISOString() })
    process.exitCode = 1
    // 替换失败已回滚时仍尝试启动旧版，避免用户"应用消失"
    if (!skipOpen && fs.existsSync(appRoot)) {
      spawnSync('open', [appRoot], { stdio: 'ignore' })
    }
  }
}

main()
