# DSH Desktop

DeepSeek Harness 桌面封装：内置 DSH Web、`dsh-codex` 和 `dsh-access-mode`，以独立应用形式运行，无需用户手动安装 Node / DSH / 插件。

- 平台：macOS（Apple Silicon / Intel）、Windows x64
- 运行时：内置 Node.js + `@deepseek-ai/dsh` + Web profile
- 插件：`dsh-codex`、`dsh-access-mode`（通过 git submodule 固定版本）

## 安装包

正式安装包发布在 GitHub Releases：

- macOS：`DSH.Desktop-<version>-arm64.dmg` / `DSH.Desktop-<version>.dmg`
- Windows：`DSH.Desktop-<version>-win.zip`（免安装压缩包）

> 未签名的预览版在 macOS 会触发 Gatekeeper 提示，在 Windows 会触发 SmartScreen 提示；正式发布建议配置代码签名。

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
npm run dist:mac   # macOS DMG（arm64 + x64）
npm run dist:win   # Windows zip（x64，建议在 Windows 上执行）
```

`prepare:runtime` 会生成 `resources/node`、`resources/runtime`、`resources/node.tar.gz`、`resources/runtime.tar.gz` 和 `resources/profile-web/node_modules`；这些目录/压缩包按平台不同，已加入 `.gitignore`，不要提交到仓库。安装包内置的是 `node.tar.gz` 和 `runtime.tar.gz`，应用首次启动时会解压到用户数据目录。

## 发布新版本

推送 `v*` tag 后，GitHub Actions 会在 macOS / Windows 上构建安装包并自动上传到 GitHub Releases：

```bash
git tag v0.1.0
git push origin v0.1.0
```

## 仓库结构

```text
dsh-desktop/
├── .github/workflows/release.yml   # 跨平台构建与发布
├── scripts/prepare-runtime.mjs     # 准备平台 Node / DSH runtime / profile
├── src/main.js                     # Electron 主进程
├── resources/                      # 图标与运行时（构建生成）
├── plugins/                        # dsh-codex、dsh-access-mode submodule
└── package.json
```

## 说明

- 应用启动时会复制内置 runtime 到用户数据目录，并在后台启动 `dsh web`。
- 更新检查通过 npm registry 获取 `@deepseek-ai/dsh` 最新版本，使用内置 npm 更新 runtime。
- 如需支持 Windows ARM64，可增加 `windows-11-arm` runner 并在 `package.json` 的 `win.target` 中加入 `arm64`。
