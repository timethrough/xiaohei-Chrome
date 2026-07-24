# 小黑多开器

> [!IMPORTANT]
> 本项目是开源项目，代码主要由 ChatGPT 在用户指导下生成和维护。应用自身的环境配置与用户数据默认保存在运行设备本地，本项目不运营用于接收这些数据的服务器；访问网站、代理检测、扩展下载等功能仍会按用户操作与相应第三方网络服务通信。运行前请自行审查源码，并使用可信杀毒软件、沙箱或其他安全工具检测；AI 审核只能作为辅助，不能替代专业安全审计。软件按“现状”提供，在适用法律允许的最大范围内，作者不对使用、修改或分发本项目造成的损失承担责任。详见 [免责声明](DISCLAIMER.md)。

本仓库保存“小黑多开器”的可审查源代码。当前版本为 **V15.0.0**，提供本地 Chrome Profile 隔离、多环境管理、代理出口检查、扩展管理、窗口同步，以及安全的 Local API、MCP Server 和 AI Skill。

## 源码位置

`xiaoheiChrome/local-functional-v2-app`

## V15 新功能

- Local API：查询、创建、更新、启动、停止和删除环境，查询运行会话与标签页。
- 自动化接入：启动环境后返回 Chrome DevTools Protocol 地址，可供 Selenium 和 Puppeteer 附加。
- MCP Server：提供 8 个环境管理工具和 OpenAPI 资源，供支持 MCP 的 AI 客户端调用。
- AI Skill：包含安全工作流与 API 参考，可用于 Claude Code、Codex、Cursor、OpenCode、Gemini GL、OpenClaw 和 Hermes agent。
- 客户端新增“API & MCP”页面，可启停接口、复制地址和 MCP 配置、重置 Key、打开 Skill 目录。

## 安全边界

- Local API 强制绑定 `127.0.0.1`，不能通过局域网或公网访问。
- 除健康检查外，所有请求必须携带随机生成的 API Key。
- 校验 Host 与 Origin，不开放 CORS，并启用请求体大小和频率限制。
- 查询响应隐藏代理账号密码、Cookie、代理刷新 URL、浏览器路径与 Profile 路径。
- MCP 不提供删除环境工具；API Key 不写进 MCP 配置文本。
- 每个环境使用独立 Chrome 用户目录，隔离 Cookie、缓存、LocalStorage 和 IndexedDB。
- 本项目不承诺规避网站风控、反机器人系统或账号关联检测。

## 验证

```powershell
cd xiaoheiChrome/local-functional-v2-app
npm ci
npm run selftest
```

自测会验证 API 鉴权、Host/Origin 限制、数据脱敏、环境 CRUD、CDP 自动化地址、MCP JSON-RPC 往返、Skill 与 UI 接线。

## 下载后运行

- 普通用户请从 GitHub Releases 下载 `小黑多开器-V15-Windows便携版.zip`，完整解压后双击 `START.cmd`。
- 便携版包含官方 Electron 43.1.1 与对应 Chromium 运行环境，但环境启动功能仍需要电脑已安装 Google Chrome。
- 便携 ZIP 大于 GitHub 仓库单文件 100 MB 限制，因此应作为 Release 附件发布，不能直接提交到源码仓库。

## 从源码构建 Windows 便携版

要求：Windows 10/11 x64、Node.js、npm、.NET Framework 4 C# 编译器，以及 Google Chrome。

```powershell
cd xiaoheiChrome/local-functional-v2-app
npm ci
npm run selftest
npm run package:portable
```

输出：

`xiaoheiChrome/local-functional-v2-app/dist/小黑多开器-V15-Windows便携版.zip`

API、MCP 与 Skill 的详细说明见 [V15 使用说明](xiaoheiChrome/local-functional-v2-app/V15-API-MCP使用说明.md)。

源码仓库通过 `.gitignore` 排除 Electron/Chromium 二进制、编译后的 EXE、浏览器 Profile、Cookies、API Key、代理凭据、日志和缓存。第三方组件的许可证和分发条件应由使用者单独遵守。