# DSH Desktop

DeepSeek Harness 桌面封装：内置 DSH Web、`dsh-codex` 和 `dsh-access-mode`，以独立应用形式运行，无需用户手动安装 Node / DSH / 插件。

- 平台：macOS（Apple Silicon / Intel）、Windows x64
- 运行时：内置 Node.js + `@deepseek-ai/dsh` + Web profile
- 插件：`dsh-codex`、`dsh-access-mode`（通过 git submodule 固定版本）

## 安装包

正式安装包发布在 GitHub Releases：

- macOS：DMG（手动安装）+ ZIP（自动更新，Apple Silicon / Intel）
- Windows：NSIS 安装包（自动更新）+ ZIP（手动下载）

> macOS 未配置代码签名，Squirrel.Mac 的签名校验无法通过，因此 macOS 自动更新
> 使用免签名自定义更新器（`src/updater/update-helper.js`，不依赖 electron-updater），
> 仅校验 SHA-512 与 BundleId；Windows 继续使用 electron-updater（NSIS 未配置
> publisherName 时不校验签名，未签名产物可正常更新）。未签名的预览版在首次
> 手动启动时仍会触发 Gatekeeper 提示，在 Windows 会触发 SmartScreen 提示；
> 正式发布如需消除提示，必须配置代码签名与公证。

## 从源码构建

需要 Node.js 22+ 和 npm。

```bash
# 克隆（包含插件 submodule）
git clone --recursive https://github.com/ddll8023/dsh-desktop.git
cd dsh-desktop

npm ci

# 准备当前平台运行时（下载 Node、安装 DSH runtime、复制插件）
npm run prepare:runtime

# 启动开发模式
npm start

# 构建当前平台安装包
npm run dist
```

也可以分别构建：

```bash
npm run dist:mac   # 当前 macOS 架构的 DMG + ZIP
npm run dist:win   # 当前 Windows 架构的 NSIS + ZIP（建议在 Windows 上执行）
```

`prepare:runtime` 会生成 `resources/node`、`resources/runtime`、`resources/node.tar.gz`、`resources/runtime.tar.gz` 和 `resources/profile-web/node_modules`；这些目录/压缩包按平台不同，已加入 `.gitignore`，不要提交到仓库。安装包内置的是 `node.tar.gz` 和 `runtime.tar.gz`，应用首次启动时会解压到用户数据目录。

## 发布新版本

每次发布完整桌面更新都必须递增 `package.json` 的版本号（**必须高于已发布的最新
版本，否则已安装用户永远收不到更新**），并推送对应的 `v*` tag。GitHub Actions 会在
macOS / Windows 上构建安装包、生成自动更新元数据并上传到 GitHub Releases：

```bash
git tag v0.1.0
git push origin v0.1.0
```

已安装用户启动应用后会检查 GitHub Releases；发现新版本时提示用户下载，下载完成后
重启应用即可更新整个软件。macOS 的 `latest-mac.yml` 由 CI 合并 arm64 / x64 两个构建
产物，Windows 使用 `latest.yml`。产物命名由 `package.json` 的 `artifactName` 统一
控制（`DSH-Desktop-${version}-${arch}-${os}.${ext}`），保证更新元数据中的 URL 与
实际上传资产名一致。

> 删除旧 Release / tag 会导致旧版本用户无法再自动更新（如删掉 v0.1.1 后发布的
> v0.1.0 低于旧版本号，semver 比较会拒绝）。删除用 `gh release delete <tag> --cleanup-tag`。

正式发布前还需要在 GitHub Actions 配置 macOS Developer ID 签名与公证、Windows Authenticode 签名。签名证书和密码只能通过 Actions Secrets 注入。

## 仓库结构

```text
dsh-desktop/
├── .github/workflows/release.yml   # 跨平台构建与发布
├── scripts/prepare-runtime.mjs     # 准备平台 Node / DSH runtime / profile
├── src/main.js                     # Electron 主进程
├── src/updater/update-helper.js    # macOS 免签名更新安装器（extraResources 打包）
├── resources/                      # 图标与运行时（构建生成）
├── plugins/                        # dsh-codex、dsh-access-mode submodule
└── package.json
```

## 说明

- 应用启动时会按 runtime manifest 将内置 Node、DSH runtime 和插件同步到用户数据目录，并在后台启动 `dsh web`。
- 桌面更新：Windows 使用 `electron-updater`；macOS 使用免签名自定义更新器（下载 ZIP 校验 SHA-512，退出后由 `update-helper.js` 校验路径安全、解压、原子替换并重启，`/Applications` 等不可写目录会弹系统授权）。更新包包含 Electron 壳、Node、DSH runtime、内置插件和 Web 资源，用户数据目录 `~/.dsh` 会保留。
- runtime 使用版本化目录和当前版本指针，更新失败时继续使用上一份可用 runtime。
- 如需支持 Windows ARM64，可增加 `windows-11-arm` runner，并在发布 workflow 的矩阵中加入 `--arm64`。
