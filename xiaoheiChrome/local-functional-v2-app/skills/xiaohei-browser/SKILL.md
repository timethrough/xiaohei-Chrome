---
name: xiaohei-browser
description: Operate local browser environments through the 小黑多开器 V15 MCP server or loopback Local API. Use when an AI agent needs to list, inspect, create, update, start, stop, proxy-check, or obtain Selenium/Puppeteer connection details for browser profiles managed by 小黑多开器.
---

# 小黑多开器

Use the V15 MCP tools whenever they are available. Fall back to the Local API only when the host cannot load MCP tools.

## Workflow

1. Confirm that 小黑多开器 V15 is running and the Local API status is healthy.
2. Call `xiaohei_list_profiles` before mutating an existing environment.
3. Refer to environments by the returned internal `id`, not only by the displayed number or name.
4. Use `xiaohei_create_profile` for a new isolated profile and `xiaohei_update_profile` for partial configuration changes.
5. Use `xiaohei_start_profile` to launch a profile. Read its `automation` object when Selenium or Puppeteer needs to attach.
6. Use `xiaohei_stop_profile` to close a profile gracefully.
7. Call `xiaohei_check_proxy` only when the operator asks to test the configured proxy.
8. Report the affected profile IDs and the returned status after every mutation.

## Safety rules

- Never reveal, print, commit, or copy the API Key, proxy password, imported Cookies, browser profile directory, or other credentials into chat.
- Never invent an environment ID. Query the current list first.
- Treat create, update, start, and stop as state-changing actions. Match the operator's stated scope exactly.
- Do not delete profiles through this skill. The MCP server intentionally does not expose deletion.
- Do not claim a browser is started until the tool returns `running: true`.
- Do not claim Selenium or Puppeteer is attached until the returned CDP endpoint has been used successfully.
- Keep the Local API on `127.0.0.1`; do not rebind it to a LAN or public interface.
- Preserve independent profile storage. Do not copy Cookies or storage between profiles unless the operator explicitly requests an in-scope migration.

## Direct API and automation

Read [references/local-api.md](references/local-api.md) when:

- the MCP host is unavailable;
- direct HTTP examples are required;
- Selenium or Puppeteer must attach to a running profile;
- API authentication or connection errors must be diagnosed.