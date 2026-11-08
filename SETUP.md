# SETUP — 新机器安装（给 agent 读）

本文件是给**在新机器上执行安装的 agent** 的操作单。按顺序做，每步都有验收判据；验收不过就走对应的失败分支，别跳步。

装完后这台机器上应当能：用 ruyijs 跑站点 JS 过挑战，用 chromium 截图取版式。缺任何一半都不算装完。

## 0. 前置（先测，别假设）

### 0.1 dsh 必须已经启动过一次

profile 由 dsh 首次启动时生成，插件只能装进已存在的 profile：

```powershell
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\package.json"   # 必须 True
```

`False` 的三种情况：dsh 还没跑过 / 刚卸载重装还没启动 / profile 被删过。
处理：正常启动一次 dsh 桌面版，**等主窗口出来再退出**，然后重测。

**不要手动创建 profile 目录** —— dsh 启动时会用自带模板重写，手写的会被覆盖。

profile 目录里应当有这 5 项，缺任何一项都说明 dsh 没正常初始化过：

```
%USERPROFILE%\.dsh\profiles\desktop\
├── package.json
├── cordis.yml
├── cordis.patch.yml
├── pnpm-lock.yaml
└── node_modules
```

### 0.2 平台与运行时

```powershell
[Environment]::Is64BitOperatingSystem          # 必须 True，ruyijs 只支持 Windows x64
python -c "import sys; print(sys.version)"     # 3.10+
node --version                                  # 18+
```

任一不满足就停下报告，不要绕。

## 1. 装引擎包

```powershell
python -m pip install --upgrade ruyijs
```

版本别停在旧包上：0.3.6 起修了进行中的 fetch 被 abort 时把 `js.exe` 打崩（Windows 上 0xC0000005），带 Kasada 之类会中止挂起请求的登录页以前直接崩。装完顺手 `python -m pip show ruyijs` 看一眼版本。

验收：

```powershell
python -c "import ruyijs, sys; print('ok', ruyijs.__file__, sys.executable)"
```

打印 `ok` 即过。多个解释器共存时，把可用那个的绝对路径记下来，之后用 `RUYIJS_PY` 钉住。

失败分支：pip 报找不到包 → 确认 Python 是 3.10+ 且 `pip --version` 指向同一解释器；内网环境按 `PIP_INDEX_URL` 配镜像。ruyijs 自带约 47MB 运行时（`site-packages\ruyijs\_runtime\dist\js.exe`），装完必须存在：

```powershell
Test-Path "<site-packages>\ruyijs\_runtime\dist\js.exe"   # 必须 True
```

## 2. 装 dsh 插件

profile 的 `package.json`：

```json
"dependencies": {
  "dsh-tool-ruyijs": "https://codeload.github.com/zhuchongba-01/dsh-tool-ruyijs/tar.gz/refs/heads/master"
},
"dsh": { "profile": { "bundles": [ ..., "dsh-tool-ruyijs" ] } }
```

两条都要有。然后在该 profile 目录跑 `pnpm install`，重启宿主。

> **pnpm 用 dsh 自带的那个，别用全局的** —— 版本对不上会改写 lockfile。
>
> ```powershell
> $pnpm = Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes" -Recurse -Filter "pnpm.cjs" -ErrorAction SilentlyContinue |
>         Where-Object { $_.FullName -like "*dependencies\pnpm\bin\*" } | Select-Object -First 1
> Set-Location "$env:USERPROFILE\.dsh\profiles\desktop"
> node $pnpm.FullName install
> ```
>
> 找不到就用 `npx pnpm@11 install`（版本见 `runtime/versions.json`）。

验收：重启后插件列表里出现 `tool-ruyijs` 且 `enabled: true`、`fiberPhase: active`。

失败分支：装上了但列表里没有 → 少写 `bundles` 那条；`pnpm install` 报 peer 冲突 → profile 的 `pnpm-workspace.yaml` 需有 `autoInstallPeers: false`。

## 3. 装浏览器（截图与交互用）

```powershell
npm i -g playwright
playwright install chromium
```

`playwright install chromium` 会一并装 headless shell 和完整 chromium。要交互或过检测又需要能点时，再补：

```powershell
playwright install firefox
```

## 4. 配路径

**不要硬编码 `ms-playwright` 下的版本目录**（`chromium_headless_shell-1228` 之类会随 playwright 升级变）。截屏走 channel：

```js
const { chromium } = require("playwright");
const b = await chromium.launch({ channel: "chromium-headless-shell" });
const p = await b.newPage();
await p.goto(URL, { waitUntil: "domcontentloaded" });
await p.screenshot({ path: OUT_PNG });
await b.close();
```

`playwright` 全局装的时候，裸 `require("playwright")` 会 MODULE_NOT_FOUND，用绝对路径：

```powershell
node -e "console.log(require.resolve('playwright'))"
```

## 5. 自检（三条全过才算装完）

```powershell
# 5.1 引擎能起、能取正文
# ruyijs_run: {url: "https://example.com", js: "document.title"}   → 期望 "Example Domain"
# 5.2 上下文能收干净
# ruyijs_close 全部关掉后：
Get-CimInstance Win32_Process | Where-Object {$_.Name -in 'js.exe','python.exe'} | Measure-Object   # 期望 Count = 0
# 5.3 截图能出图
node <上一步的截图脚本>
(Get-Item OUT_PNG).Length    # 小于 8KB 多半是连接失败页，不是目标站内容
```

## 6. 失败分支

| 现象 | 处理 |
|---|---|
| `no Python with the ruyijs package` | 设 `RUYIJS_PY` 指向能 `import ruyijs` 的解释器绝对路径 |
| `ruyijs requires Windows x64` | 平台不对，换机器或用 `RUYIJS_SHELL` 指定外部 js.exe |
| `chromium.launch: Executable doesn't exist` | `playwright install chromium` 没装完，重跑 |
| 截图 0 字节 / 极小 | 别用完整 `chrome.exe`（本机上是先写图再挂着不退），改 channel 写法 |
| 导航报 `empty document` | 页面真没内容，用 `load_page` 喂 HTML，或确认站点要登录态 |

## 7. 分工（装完也要守）

1. 静态页 / 接口直出 → `web_fetch`，不启任何浏览器
2. 正文靠 JS 跑出来 / 有挑战 / 查 TLS 指纹 → `ruyijs_run`
3. 截图、看版式 → chromium headless shell（配方见第 4 步）
4. 既要过检测又要点击 → playwright + firefox

`ruyijs` 没有排版引擎，别拿它做点击流；chromium 的指纹是 Chrome，别拿它硬刚风控站。
