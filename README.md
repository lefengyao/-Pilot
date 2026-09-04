# 智驭 Pilot

一个运行在 Windows 主机上的局域网网页工作台。打开浏览器即可创建独立的 PowerShell 或 CMD 终端，并在受限的文件工作区中浏览、预览和管理项目文件。

> 适用场景：家庭网络、办公室内网、开发机远程维护等可信局域网环境。
>
> 本项目没有普通用户登录系统。能够访问服务地址的用户，会以运行 Node.js 服务的 Windows 账号执行命令。请不要把它直接暴露到公网。

## 功能

### 网页终端

- 独立创建 PowerShell 或 CMD 进程，每个会话互不影响。
- 使用浏览器终端渲染 ANSI 颜色、光标和常见终端交互。
- 支持多个会话切换、输出历史、清空显示、重新连接和刷新恢复。
- 可在网页内选择初始工作目录，不调用 Windows 资源管理器。
- 普通用户只能选择 `ALLOWED_ROOT` 及其真实子目录。
- 可选管理员密钥；管理员可以临时选择服务账号有权限访问的其他目录来启动终端。
- 可单独结束、重启和删除已经退出的终端会话。

### 文件工作区

- 终端页点击“文件”后进入独立的 `/files.html` 页面。
- 使用左侧目录树浏览 `ALLOWED_ROOT` 及其子目录。
- 支持文本、图片、PDF、音频和视频预览。
- DOC/DOCX 使用 Mammoth 预览，XLS/XLSX 使用 SheetJS 预览；其他不支持的格式提供下载。
- 支持点击选择或拖放上传，上传过程按文件流式处理。
- 同名文件自动生成 `_1`、`_2` 等后缀，避免覆盖已有文件。
- 支持下载、重命名、删除文件、新建文件夹和删除空文件夹。
- 不显示 `.env`、`.env.*`、`.git` 等敏感项目内容，也不会跟随符号链接访问工作区外的文件。
- 管理员解锁不会扩大文件工作区的根目录范围。

## 技术栈

- Node.js 20+
- Express 5
- WebSocket (`ws`)
- `node-pty`
- `@xterm/xterm`
- Busboy 流式上传
- Mammoth 和 SheetJS 浏览器预览

## 环境要求

- Windows 10 或 Windows 11
- Node.js 20 或更高版本
- `node-pty` 可用的安装环境

`node-pty` 是原生模块。通常会直接使用预构建包；如果安装失败，需要准备对应的 Visual Studio C++ 编译工具。

## 安装和启动

在 PowerShell 中执行：

```powershell
git clone <你的 GitHub 仓库地址>
cd 智驭Pilot
npm install
Copy-Item .env.example .env
```

编辑 `.env`。最小配置如下：

```dotenv
HOST=0.0.0.0
PORT=3000
ALLOWED_ROOT=terminal-workspace
ADMIN_KEY=
```

如果需要管理员目录模式，请将 `ADMIN_KEY` 替换为至少 32 个字符的随机密钥。不要把 `.env` 提交到 Git；项目已通过 `.gitignore` 排除它。

确保 `ALLOWED_ROOT` 已存在。默认的 `terminal-workspace` 目录已包含 `.gitkeep`，克隆后可以直接使用。

启动服务：

```powershell
npm start
```

开发模式（文件变化后自动重启）：

```powershell
npm run dev
```

启动后打开：

```text
http://127.0.0.1:3000
```

局域网内其他设备访问时，将 `127.0.0.1` 换成运行服务的 Windows 主机 IPv4 地址，例如 `http://192.168.1.20:3000`。可以用下面的命令查看地址：

```powershell
ipconfig
```

## 使用方法

### 创建终端

1. 打开首页，点击“新建终端”。
2. 选择 PowerShell 或 CMD，并填写可选的会话名称。
3. 点击“选择目录”，在网页目录选择器中进入目标子目录。
4. 如需访问普通工作区以外的目录，先输入管理员密钥解锁。
5. 点击“创建并连接”。

终端会话显示在左侧栏。选择会话可以切换终端；“结束当前”会终止该会话进程，进程退出后可以从侧栏删除会话记录。

### 访问文件工作区

点击左侧“文件”按钮后，页面会跳转到独立的文件工作区。选择目录或文件即可浏览内容和打开预览；完成后点击“← 终端”返回终端页面。

## 配置参考

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | HTTP 和 WebSocket 监听地址。只需要单个网卡时，建议填写对应的局域网 IPv4。 |
| `PORT` | `3000` | HTTP 和 WebSocket 端口，范围 `1-65535`。 |
| `ALLOWED_ROOT` | `terminal-workspace` | 普通终端和文件工作区的根目录。相对路径按项目目录解析，目录必须已存在。 |
| `ADMIN_KEY` | 空（关闭） | 至少 32 个字符。启用后，管理员令牌默认 15 分钟有效。 |
| `MAX_SESSIONS_PER_CLIENT` | `8` | 单个浏览器身份最多保留的会话数，范围 `1-64`。 |
| `MAX_SESSIONS_TOTAL` | `64` | 服务最多保留的会话数，范围 `1-512`。 |
| `MAX_MESSAGE_BYTES` | `65536` | WebSocket 入站消息上限，范围 `1024` 字节至 `1 MiB`。 |
| `MAX_HISTORY_BYTES` | `524288` | 单个终端保留的输出历史上限，范围 `1024` 字节至 `16 MiB`。 |
| `OUTPUT_BATCH_MS` | `16` | 终端输出批量发送间隔，范围 `0-1000` 毫秒。 |
| `MAX_UPLOAD_BYTES` | `2147483648`（2 GiB） | 文件工作区单个文件上传上限，范围 `1 MiB-8 GiB`。 |

管理员密钥只用于管理员目录选择和启动工作目录在 `ALLOWED_ROOT` 之外的终端。它不会让文件工作区访问其他目录，也不会改变 Windows 账号本身的权限。

## Windows 防火墙

只有在确认网络为可信 Private 网络后，才建议开放端口。使用管理员 PowerShell 执行：

```powershell
New-NetFirewallRule `
  -DisplayName '智驭 Pilot TCP 3000' `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 3000 `
  -Action Allow `
  -Profile Private
```

不再使用时删除规则：

```powershell
Remove-NetFirewallRule -DisplayName '智驭 Pilot TCP 3000'
```

## 安全注意事项

- 这是可信局域网工具，不是公网远程桌面或多用户 SaaS。
- 访问者可以执行命令、上传文件、重命名文件和删除文件；请只在可信网络中运行。
- 服务使用运行 Node.js 的 Windows 账号执行 PowerShell/CMD。不要使用本地管理员账号运行服务。
- 当前默认是 HTTP，管理员密钥会以明文传输。需要跨不可信网络使用时，应在前面配置 HTTPS 反向代理，并限制网络访问范围。
- `ALLOWED_ROOT` 必须指向专用工作区，不要直接指向项目源码目录、用户目录或磁盘根目录。
- 管理员模式只扩大终端初始工作目录能力，并不会提升 Windows 权限。

## 接口速查

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/healthz` | 健康检查，成功返回 `{"ok":true}`。 |
| `POST` | `/api/admin/unlock` | 使用管理员密钥换取短时令牌。 |
| `GET` | `/api/directories?path=.` | 浏览终端初始工作目录。管理员令牌可浏览任意可访问目录。 |
| `GET` | `/api/workspace/tree?path=.` | 浏览文件工作区目录树。 |
| `GET` | `/api/workspace/content?path=...` | 读取或下载文件。加 `download=1` 下载。 |
| `POST` | `/api/workspace/upload` | 上传一个或多个文件。 |
| `POST` | `/api/workspace/folders` | 新建文件夹。 |
| `PATCH` | `/api/workspace/entries` | 重命名文件或文件夹。 |
| `DELETE` | `/api/workspace/entries?path=...` | 删除文件或空文件夹。 |
| `GET` | `/ws` | 终端 WebSocket 连接。 |

## 测试

运行完整测试套件：

```powershell
npm test
```

测试覆盖配置校验、目录边界、管理员令牌、WebSocket 会话、进程停止/重启、文件浏览、预览、上传、重命名和删除。浏览器测试需要本机安装 Microsoft Edge。

## 项目结构

```text
server/
  index.js             服务入口
  app.js               Express 和 WebSocket 服务组装
  config.js            环境变量解析和边界校验
  session-manager.js   多终端会话管理
  terminal-session.js  单个 PTY 会话
  workspace-files.js   文件工作区 API
  directory-browser.js 终端目录选择 API
public/
  index.html           终端页面
  app.js               终端页面逻辑
  files.html           独立文件工作区页面
  file-workspace.js    文件浏览和操作逻辑
test/                   单元、集成和浏览器测试
docs/                   设计说明和实现计划
terminal-workspace/    默认运行时工作区
```

## GitHub 推送

在项目目录中执行：

```powershell
git add -A
git commit -m "初始化智驭 Pilot"
git branch -M main
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

推送前确认以下内容没有出现在 `git status` 中：`.env`、`node_modules/`、`.codex/`、`.superpowers` 以及 `terminal-workspace` 内的运行时文件。
