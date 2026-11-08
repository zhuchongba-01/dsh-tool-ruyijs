# dsh-tool-ruyijs

给 dsh 的四个工具，用 **ruyijs**（真 Firefox 引擎：SpiderMonkey + Necko，无窗口无渲染）跑站点自己的 JavaScript。
截图走 chromium headless shell，配方见下。

- 插件本体：装成 profile 依赖后位于 `<profile>\node_modules\dsh-tool-ruyijs`
- 依赖的 Python 包：`ruyijs`（PyPI，Windows x64，Python 3.10+）
- 与 dsh 的挂载：profile `package.json` 里一条依赖 + `dsh.profile.bundles` 登记

## 安装（新机器）

**拿到新机器先读 [SETUP.md](./SETUP.md)** —— 那份是给执行安装的 agent 的操作单，含前置检查、浏览器装法、路径配置和三条自检。下面是摘要：

0. **先让 dsh 正常启动一次**（主窗口出来再退出）。profile 目录 `%USERPROFILE%\.dsh\profiles\desktop` 由 dsh 首次启动时生成，里面有 `package.json`、`cordis.patch.yml`、`node_modules`；没这一步，下面第 2 步没文件可改。**别手动建 profile**，dsh 会用自带模板覆盖。
1. 装引擎包：`python -m pip install ruyijs`
2. profile `package.json` 的 `dependencies` 加一条：
   ```json
   "dsh-tool-ruyijs": "https://codeload.github.com/zhuchongba-01/dsh-tool-ruyijs/tar.gz/refs/heads/master"
   ```
3. 同一文件的 `dsh.profile.bundles` 末尾登记 `"dsh-tool-ruyijs"`
4. 在 profile 目录跑一次 `pnpm install`，重启宿主

想跟着本机改代码就改用本地链接：先把仓库 clone 到 `%USERPROFILE%\.dsh\plugins\dsh-tool-ruyijs`，再把第 2 步换成 `"dsh-tool-ruyijs": "link:C:/Users/<用户名>/.dsh/plugins/dsh-tool-ruyijs"`，第 3、4 步不变。

## 四个工具

| 工具 | 用途 |
|---|---|
| `ruyijs_run` | 打开页面 / 跑 JS / 取签名 / 过挑战，返回结果 + console + net 记录 |
| `ruyijs_net` | 读当前上下文的请求日志与 console（不触发新请求） |
| `ruyijs_handoff` | 把此上下文的身份交给真浏览器：全量 cookie（含 HttpOnly）、UA、localStorage，外带一段可直接跑的 Playwright |
| `ruyijs_close` | 关掉某个 origin 的上下文，或不带 url 全关 |

### `ruyijs_run` 参数

| 参数 | 说明 |
|---|---|
| `js` *(必填)* | 要执行的 JS。表达式或用 `advanceMs` + `read` 分两步 |
| `url` | 先导航到这里。同一 origin 后续调用可省略；上下文已被回收时必须重新给 |
| `advanceMs` | 执行后推进事件循环的毫秒数，等定时器 / fetch / promise 落定 |
| `read` | `advanceMs` 之后再求值的表达式，其值代替 `js` 的结果返回 |
| `proxy` | 新建上下文时用：`http://`、`https://`、`socks5://`；复用时不生效 |
| `fingerprint` | 新建上下文时的画像，如 `{"navigator":{"language":"zh-CN"},"locale":{"timezone":"Asia/Shanghai"}}` |
| `timeoutMs` | 单次操作超时，默认 60000 |
| `idleSeconds` | 空闲多少秒后回收上下文，默认 180 |
| `maxBytes` | 返回文本与值的字节上限，默认 65536，超出落盘 |

返回固定形状：`{ok, text, value, error, name, stack, console, net, truncated, spilledTo}`。
成功与失败都是这个形状，不会出现"抛异常"和"返回值"两套判断。

## 生命周期

- **按需拉起**：第一次调用才 spawn 一个 Python daemon，进程内持有一个 ruyijs `Context`。
- **并发上限**：同时最多 6 个上下文，超出时先杀最久没被调用的那个（`RUYIJS_MAX_CONTEXTS` 可改）。一个上下文就是三个进程约 120MB，不设限等于把机器交给运气。
- **按 origin 复用**：key 是 `会话ID|origin`。同一 origin 的后续调用接回同一个世界，`globalThis` 上的变量和已加载的页面都还在。
- **无 url 调用**：接回本会话上一次用过的 origin。
- **回收**：空闲 `idleSeconds`、`ruyijs_close`、工具超时、宿主退出，四种都会杀进程（含它的子进程）。
- **回收后再调**：明确返回 `no live ruyijs context ...`，**不会**静默开一个空白页。

一个上下文实占 3 个进程（runner + js.exe + 1 个 vendored python worker，约 120MB 常驻），这是 ruyijs 的正常结构，不是泄漏。关闭后归零。

## 输出截断与清理

- 返回内容超过 `maxBytes`：`text` 与 `value` 都被截断，全文写到 `runs/<时间戳>-value.txt`，render 里直接给路径。
- 更早的一道闸在 runner 里：单条回复超过 24MB 就先在那边截（Node 侧行缓冲超过 32MB 会整段丢弃，必须挡在前面），这时 `truncated` 为 `true` 但 `spilledTo` 为空——落盘的是已截的部分。
- 比这更早的是 ruyijs 自己的值遍历预算：实测 1 MiB 的字符串能整段回来，1.5 MiB 就报 `Host value traversal budget exceeded`，界卡在 1 MiB 出头，跟版本无关（0.1.9 与 0.3.6 同）。要整段大正文就分片取（按 `slice` 分段、或先写进 `globalThis` 再按块读），别指望一次扛。
- `runs/` 自动清理：每次落盘后和每次宿主启动时扫一遍——先删超过 **7 天**的，再按最旧优先删到总量 **200MB** 以内。删不掉（被占用）就跳过，不影响调用。
- `%TEMP%` 下其他工具的遗留目录不由插件处理。人工清垃圾时顺带看一眼 `%TEMP%`，这几类通常是死的：`wrs-chrome-*`、`edge-keeper-clean*`、`cr-*`、`playwright_chromiumdev_profile-*`、`playwright-artifacts-*`。

## 解释器解析

按顺序试，命中第一个能 `import ruyijs` 的：

1. `RUYIJS_PY` 环境变量
2. `python.exe` / `python` / `py -3`（PATH）
3. `%LOCALAPPDATA%\Programs\Python\Python3*`、`C:\Python3*`、`%ProgramFiles%\Python3*`

所以换 Python 小版本、重装解释器都不用改插件；换位置或多版本共存时用 `RUYIJS_PY` 钉死。

## 宿主包解析

`@deepseek-ai/dsh-tools` 依次尝试：裸名 → `process.resourcesPath/app/dsh/node_modules` → exe 同级 `resources\app` → `DSH_APP_DIR`。插件自带的那个 junction 只是让第一种生效；DSH 升级换了路径也能靠后面几种起来。

## 截图配方（不开 UI、不建 profile）

```js
const { chromium } = require("playwright");
const b = await chromium.launch({ channel: "chromium-headless-shell" });
const p = await b.newPage();
await p.goto(URL, { waitUntil: "domcontentloaded" });
await p.screenshot({ path: OUT_PNG, fullPage: false });
await b.close();
```

用 channel 而不是拼 `ms-playwright` 下的版本目录，playwright 升级换 rev 也不用改。装法见 [SETUP.md](./SETUP.md) 第 3 步。

图小于 8KB 基本是连接失败页，不是目标站内容——需要确认时看图，或用 playwright 拿状态码。

**为什么不直接 `chrome.exe`**：本机上是"先写出图、然后挂着不退出"，同步等会卡死（实测 45 秒不退出且文件都没落地）。

## 与其他工具的分工

见 `~/.dsh/AGENTS.md` 第 7 条：

1. 静态页 / 接口 → `web_fetch`，不启浏览器
2. JS 渲染 / 挑战 / 签名 / TLS 指纹 → 本插件
3. 过完门要交给浏览器 → `ruyijs_handoff` 拿身份，别手拼 cookie
4. 截图 / 点击 / 版面 / 下载 → chromium（截图用 headless shell，交互走 playwright）
5. 既要过检测又要交互 → 上面 2+3+4 串起来；全程同一指纹就留在 `ruyijs_run`

**ruyijs 不做点击流**：没有排版引擎，元素位置和可视区判断不可信。

## 与浏览器的接力

它不跟浏览器抢活，位置在浏览器门口：让站点自己的脚本跑完、签出 cookie / token、观察完整请求链，再把身份交给浏览器去看版式、截、点。反方向同样成立——浏览器里看中的地址和元素，回这里按同一套头取正文。

交接不用手拼，`ruyijs_handoff` 一次给全：引擎里那份**含 HttpOnly** 的 cookie jar（`export_cookies`，页面自己读 `document.cookie` 是拿不到 HttpOnly 的）、当前 UA、页面的 localStorage，外加一段装好这三样再去截图的 Playwright 脚本。

```
1) ruyijs_run {url: TARGET}                       // 过门
2) ruyijs_run   执行站点需要的那段签名 / 挑战
3) ruyijs_handoff {url: TARGET}                   // 拿 cookies / userAgent / localStorage / script
4) 把返回的 script 落成文件跑起来                  // 带同一副身份截图、点击
```

`script` 里已经写好了 `addCookies`、`addInitScript`（localStorage 必须在 `goto` 之前注入，晚写就是空的）和 screenshot，改个路径就能用。

一个真限制：**指纹只在各自那一跳有效**。这半程是 Firefox 的 TLS 特征，交给 Chromium 之后那半程就是 Chrome 的，站点若在会话中途二次比对会露。要求全程同一指纹的场合，别换，留在 `ruyijs_run` 里把活干完。

`ruyijs_net` 读出的请求顺序、头、参数可以直接当协议规格，交给浏览器或 `web_fetch` 复现。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `no Python with the ruyijs package` | 装包：`python -m pip install ruyijs`；或设 `RUYIJS_PY` |
| `no live ruyijs context ...` | 上下文被回收，重新带 `url` |
| `navigation produced an empty document (2 attempts)` | 目标没有解析出内容，可能被拦或需 `load_page` 喂 HTML |
| `Host value traversal budget exceeded` | 返回值太大（5MB 级），引擎带不回来；分片取 |
| `ruyijs op timed out after N ms` | 页面卡住或脚本死循环。上下文先留 15 秒宽限等那笔迟到的回复——期间别的调用还能接回同一个世界；宽限过了仍无回应才杀上下文，重调即可 |
| 插件加载报找不到 `@deepseek-ai/dsh-tools` | 设 `DSH_APP_DIR` 指向 dsh 安装根，或重建插件内 junction |
| 截图 0 字节 | 别用完整 chrome.exe，改用 headless shell（配方见上） |

## 卸载

1. 从 profile `package.json` 移除 `dependencies` 里那一条和 `dsh.profile.bundles` 里的 `dsh-tool-ruyijs`
2. 删 `<profile>\node_modules\dsh-tool-ruyijs`（用 link 安装的，副本本身可留）
3. 重启宿主

不动 Python 环境；`ruyijs` 包留着不影响任何东西，要去掉就 `python -m pip uninstall ruyijs`。

## 版本

- 插件 0.2.1
- ruyijs 0.3.6（PyPI）
- chromium / headless shell 149.0.7827.55（playwright rev 1228）


