在真 Firefox 引擎里跑目标站自己的 JavaScript：SpiderMonkey 执行、Necko 发请求，没有渲染器也没有窗口。给 DSH 三个工具——`ruyijs_run` 开页跑脚本取签名，`ruyijs_net` 读那次的请求与 console 记录，`ruyijs_close` 按 origin 收上下文。

**什么时候用它**：正文要等站点自己的脚本跑完才出现；要过 bot 检查；站点查 TLS 指纹；要看一条带签名的请求链。静态页和裸接口交给 `web_fetch`，别为它拉进程。

**什么时候别用它**：截图、点击、量版式、判断可视区——没有排版引擎，元素位置不可信，那些交给 chromium headless shell（配方在 README）。

一个上下文常驻四个进程约 155MB，这是 ruyijs 的正常结构，不是泄漏。首次调用才拉起，空闲 `idleSeconds` 秒后自行回收；回收后再调会明确报 `no live ruyijs context`，带上 `url` 重开即可。

安装、完整参数、排错表和卸载都在仓库的 README 与 SETUP.md。
