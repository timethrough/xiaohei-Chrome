# Local API reference

## Contents

- [Connection](#connection)
- [Endpoints](#endpoints)
- [Profile fields](#profile-fields)
- [Puppeteer](#puppeteer)
- [Selenium](#selenium)
- [Troubleshooting](#troubleshooting)

## Connection

The app binds the API to `http://127.0.0.1:51415` by default. Read the current URL and API Key from the app's **API & MCP** page. Send the key in one of these forms:

```http
X-API-Key: <local-api-key>
Authorization: Bearer <local-api-key>
```

Never store the key in source control. The key file is local to the current Windows user.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/health` | Unauthenticated loopback health check |
| GET | `/api/v1/status` | API and profile counts |
| GET | `/api/v1/profiles` | List profiles; accepts `q`, `running`, `page`, `pageSize` |
| POST | `/api/v1/profiles` | Create a profile |
| GET | `/api/v1/profiles/{id}` | Read a redacted profile |
| PATCH | `/api/v1/profiles/{id}` | Partially update a profile |
| DELETE | `/api/v1/profiles/{id}` | Delete a profile; direct API only |
| POST | `/api/v1/profiles/{id}/start` | Start and return CDP automation details |
| POST | `/api/v1/profiles/{id}/stop` | Stop gracefully |
| POST | `/api/v1/profiles/{id}/check-proxy` | Check proxy exit |
| GET | `/api/v1/profiles/{id}/automation` | Read the running CDP endpoint |
| GET | `/api/v1/sessions` | List running profiles and tabs |
| GET | `/api/v1/openapi.json` | OpenAPI document |

Example:

```powershell
$headers = @{ 'X-API-Key' = $env:XIAOHEI_API_KEY }
Invoke-RestMethod -Headers $headers -Uri 'http://127.0.0.1:51415/api/v1/profiles'
```

## Profile fields

Create and update requests can include `name`, `number`, `proxy`, `language`, `tag`, `width`, `height`, `userAgent`, `privacy`, and `advanced`. Profile IDs are immutable after creation. Partial updates merge nested `privacy`, `advanced`, and `proxyMeta` objects.

Profile responses redact proxy credentials, imported Cookies, executable paths, and local profile directories.

## Puppeteer

Start the profile, then connect using the returned WebSocket endpoint:

```js
const started = await startProfile();
const browser = await puppeteer.connect({
  browserWSEndpoint: started.data.automation.browserWSEndpoint
});
```

Do not launch another browser against the same profile directory.

## Selenium

Start the profile, then attach ChromeDriver to the returned debugger address:

```python
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

options = Options()
options.debugger_address = started["data"]["automation"]["debuggerAddress"]
driver = webdriver.Chrome(options=options)
```

ChromeDriver must be compatible with the installed Google Chrome version.

## Troubleshooting

- `ECONNREFUSED`: launch 小黑多开器 and confirm Local API is enabled.
- `401`: copy the current key again or reset it in **API & MCP**.
- `403 Invalid Host`: connect through `127.0.0.1` or `localhost`, not another hostname.
- `409 Profile is not running`: start the profile before requesting automation details.
- Missing `browserWSEndpoint`: wait for Chrome CDP initialization, then retry the automation endpoint.
## Skill installation

For Claude Code, Codex, Cursor, OpenCode, Gemini and other agents supported by the open Skills CLI:

```powershell
npx skills add timethrough/xiaohei-Chrome --skill xiaohei-browser -g
```

For OpenClaw:

```powershell
npx skills add timethrough/xiaohei-Chrome --skill xiaohei-browser -g -a openclaw
```

For Hermes agent, copy the complete `xiaohei-browser` folder to `~/.hermes/skills/xiaohei-browser`. Configure the MCP server separately in every client.