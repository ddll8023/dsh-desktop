---
name: dsh-desktop-release
description: 将 DSH Desktop（DeepSeek Harness 桌面封装）打包发布到 GitHub，适配 macOS（Apple Silicon/Intel）和 Windows x64。当需要发布 dsh-desktop、处理跨平台打包、修复 Windows 构建卡住/慢、同步 GitHub Release 文档或校验发布包时使用。
---

# DSH Desktop 跨平台打包与 GitHub 发布

本 skill 记录 dsh-desktop 从源码到 GitHub Release 的完整方法、已踩过的坑和验证方式。适用于当前项目 `dsh-desktop/`。

## 项目事实

- 技术栈：Electron + electron-builder，内置独立 Node.js 和 `@deepseek-ai/dsh` runtime。
- 插件：`dsh-codex`、`dsh-access-mode`，通过 git submodule 放在 `plugins/`。
- 构建产物：macOS DMG（arm64/x64）、Windows zip（x64）。
- 关键脚本：
  - `scripts/prepare-runtime.mjs`：安装 DSH runtime、复制插件、下载独立 Node，并打包成 `node.tar.gz` / `runtime.tar.gz`。
  - `src/main.js`：应用启动时把 tar.gz 解压到用户数据目录，再启动 `dsh web`。
  - `.github/workflows/release.yml`：tag 触发跨平台构建并发布 GitHub Release。
  - `.github/workflows/verify-release.yml`：下载已发布资产并校验结构。

## 发布流程

1. 确保本地干净：
   ```bash
   git status --short
   ```
2. 推送代码到 `main`：
   ```bash
   git push origin main
   ```
3. 打 tag 触发 release workflow：
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
4. 在 GitHub Actions 查看 `release` workflow，等待三个 build job 和 release job 全部成功。
5. 触发 `verify-release` workflow 校验发布包结构：
   ```bash
   # 通过 GitHub UI 或 API dispatch verify-release，输入 tag v0.1.0
   ```
6. 确认 Release 页资产：
   - `DSH.Desktop-<version>-arm64.dmg`
   - `DSH.Desktop-<version>.dmg`
   - `DSH.Desktop-<version>-win.zip`

## 本地构建

```bash
cd dsh-desktop
npm ci

# 生成当前平台 runtime 和 tar.gz（需要能调用 npm；本机若没有全局 npm，可用 bundled npm）
PATH="$PWD/resources/node/bin:$PATH" \
  resources/node/bin/node resources/node/lib/node_modules/npm/bin/npm-cli.js run prepare:runtime

npm run dist:mac   # macOS DMG
npm run dist:win   # Windows zip（建议在 Windows 上执行）
```

## 关键设计

### 为什么用 tar.gz 而不是直接打包 node_modules

`resources/runtime` 的 `node_modules` 有数万个小文件，直接让 electron-builder 打进安装包在 Windows 上非常慢，且 Windows Defender 会进一步放大耗时。

解决：`prepare-runtime.mjs` 在安装完 runtime 后把 `resources/runtime` 和 `resources/node` 分别打成 `runtime.tar.gz` / `node.tar.gz`。`package.json` 的 `extraResources` 只携带这两个压缩包和 `profile-web`。应用首次启动时用系统 `tar` 解压到用户数据目录。

### 应用首次启动解压

`src/main.js` 中：
- `bundledArchives` 检测 `resources/node.tar.gz` / `resources/runtime.tar.gz`。
- `ensureRuntime()` 用 `tar -xzf <archive> -C <dest> --strip-components=1` 解压到 `userData/node` 和 `userData/runtime`。
- 解压后 `nodeBin` / `npmCli` 指向 `userData` 下的 Node，而不是 `resources` 下的目录。

## 已踩过的坑与解决方案

| 问题 | 原因 | 解决方案 |
| --- | --- | --- |
| Windows 上 `spawnSync npm.cmd EINVAL` | Node 直接 spawn `.cmd` 在 Windows 不可用 | `prepare-runtime.mjs` 的 `run()` 对 Windows 使用 `npm.cmd` 并加 `shell: true` |
| electron-builder 报 `GitHub Personal Access Token is not set` | 构建阶段尝试自动 publish | 构建命令加 `--publish never`，由单独 release job 上传 |
| `-c.compression=store` 被当成文件路径 | electron-builder CLI 点号覆盖语法错误 | 使用 `--config.compression=store` |
| Windows 打包几十分钟不结束，日志出现大量 `Can't add archive to itself` | `npm install` 在 Windows 的 `runtime/node_modules/dsh-desktop` 生成了指向仓库根目录的 junction，`tar` 递归打包自己 | 归档前删除该 self-link：`fs.rmSync(path.join(runtimeDir, 'node_modules', 'dsh-desktop'), { recursive: true, force: true })` |
| 每次 CI 都全量下载/安装，耗时很长 | 没有缓存 | 在 release workflow 中加 `actions/cache`，缓存 `resources/node`、`resources/runtime`、`node.tar.gz`、`runtime.tar.gz` |
| 任务长时间卡住但看不到中间输出 | GitHub API 在 job 结束前不返回完整日志 | 使用 GitHub Actions 网页看实时日志；脚本加带时间戳日志；给 Prepare/Build 步骤加 `timeout-minutes` |
| Windows NSIS 安装包构建太慢 | 需要压缩大量小文件 | Release 改用 Windows zip，并在必要时用 `--config.compression=store` |
| Release 资产名与 README 不一致 | electron-builder 默认命名与预期不同 | 以实际资产名为准更新 README 和 Release body，并用 `verify-release.yml` 自动校验 |

## 验证清单

发布前/后必须确认：

- [ ] `prepare-runtime.mjs` 能生成 `node.tar.gz` 和 `runtime.tar.gz`，且不是 0 字节。
- [ ] tar.gz 能解压，解压后 `node -v` 正常、`runtime/node_modules/@deepseek-ai/dsh/package.json` 存在。
- [ ] `release` workflow 三个 build job 全部 success。
- [ ] `verify-release` workflow 三个 job 全部 success：
  - macOS DMG 内有 `DSH Desktop.app`、`node.tar.gz`、`runtime.tar.gz`、`profile-web`
  - Windows zip 内有 `DSH Desktop.exe`、`node.tar.gz`、`runtime.tar.gz`、`profile-web`
- [ ] GitHub Release 页资产名、使用说明与 README 一致。

## 注意事项

- 当前安装包未签名：macOS 会触发 Gatekeeper，Windows 会触发 SmartScreen。
- `v0.1.0` tag 指向实际构建成功的提交；文档更新如果只改 README/workflow，不需要重新打 tag，除非要求 tag 内文档也同步。
- Windows 构建必须在 Windows runner 上执行；在 macOS 上交叉构建 Windows 安装包不可靠。
