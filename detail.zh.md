正文要等站点自己的脚本跑完才出现、要过 bot 检查、站点查 TLS 指纹时用它；静态页和裸接口交给 `web_fetch`，别为它拉进程。

没有排版引擎，截图、点击、量版式交给 chromium headless shell。

一个上下文四个进程约 155MB，是正常结构不是泄漏；空闲 `idleSeconds` 秒自动回收。参数与排错见 README。
