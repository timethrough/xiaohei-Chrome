# V15 API、MCP 与 Skill 使用说明

## 1. 启用 Local API

打开“小黑多开器”左侧的 **API & MCP** 页面，确认状态为“接口运行中”。默认地址是：

```text
http://127.0.0.1:51415
```

业务接口必须携带页面中显示的 Key：

```http
X-API-Key: <本机 Key>
```

不要把 Key、Cookie 或代理凭据粘贴到公开 Issue、聊天记录或代码仓库。

## 2. API 示例

```powershell
$base = 'http://127.0.0.1:51415'
$headers = @{ 'X-API-Key' = '<从客户端复制>' }

# 查询环境
Invoke-RestMethod -Headers $headers -Uri "$base/api/v1/profiles"

# 创建环境
$body = @{ name = '测试环境'; language = 'zh-CN'; proxy = 'Direct' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' -Body $body -Uri "$base/api/v1/profiles"

# 启动环境
Invoke-RestMethod -Method Post -Headers $headers -Uri "$base/api/v1/profiles/env-001/start"
```

完整接口定义：`GET /api/v1/openapi.json`。

## 3. Selenium 与 Puppeteer

先通过启动接口启动环境，再读取响应的 `data.automation`：

- Puppeteer 使用 `browserWSEndpoint` 调用 `puppeteer.connect()`。
- Selenium 使用 `debuggerAddress` 设置 `Options().debugger_address`。
- 不要再用同一个 Profile 目录启动第二个浏览器进程。
- Selenium 的 ChromeDriver 版本必须兼容当前安装的 Google Chrome。

## 4. MCP

在 **API & MCP** 页面点击“复制配置”，把 JSON 合并进所用 AI 工具的 MCP 配置。该配置通过 stdio 启动本地 MCP 子进程，Key 从当前用户的本地设置文件读取，不出现在配置文本中。

可用工具：

- `xiaohei_list_profiles`
- `xiaohei_get_profile`
- `xiaohei_create_profile`
- `xiaohei_update_profile`
- `xiaohei_start_profile`
- `xiaohei_stop_profile`
- `xiaohei_check_proxy`
- `xiaohei_list_sessions`

## 5. Skill

客户端会显示并可复制安装命令。Claude Code、Codex、Cursor、OpenCode、Gemini 等可使用通用 Skills CLI：

```powershell
npx skills add timethrough/xiaohei-Chrome --skill xiaohei-browser -g
```

OpenClaw：

```powershell
npx skills add timethrough/xiaohei-Chrome --skill xiaohei-browser -g -a openclaw
```

Hermes agent 可把客户端显示的本机 Skill 目录复制到 `$HOME\.hermes\skills\xiaohei-browser`。安装 Skill 后仍需配置上方 MCP Server；不同工具的加载规则可能更新，请以对应产品的最新文档为准。

## 6. 常见问题

- `ECONNREFUSED`：先启动客户端并启用 Local API。
- `401`：Key 错误或已被重置；重新复制当前 Key。
- `403 Invalid Host`：只能使用 `127.0.0.1` 或 `localhost`。
- `403 Cross-origin`：浏览器网页不能跨站直接调用该接口，请使用本地程序、MCP 或后端脚本。
- `409 Profile is not running`：先启动环境，再查询自动化连接信息。