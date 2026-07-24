'use strict';
const cdp = require('./cdp');

async function waitForRenderer() {
  let last;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const tab = (await cdp.tabs(9333))[0]; if (tab) return tab; }
    catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw last || new Error('V15 renderer was not available on port 9333');
}

async function main() {
  const tab = await waitForRenderer();
  const expression = `(async () => {
    for (let attempt = 0; attempt < 80 && !(document.querySelector('#api-key')?.value?.length >= 48); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    document.querySelector('[data-view="api"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const info = await window.ops.getApiInfo();
    document.querySelector('[data-automation-tab="selenium"]')?.click();
    const mcpText = document.querySelector('#mcp-config')?.textContent || '';
    let mcpValid = false; try { mcpValid = Boolean(JSON.parse(mcpText).mcpServers?.['xiaohei-local-api']); } catch (_) {}
    return {
      title: document.querySelector('#page-title')?.textContent || '',
      active: document.querySelector('#view-api')?.classList.contains('active') || false,
      status: document.querySelector('#api-status-text')?.textContent || '',
      url: document.querySelector('#api-url')?.textContent || '',
      keyLength: document.querySelector('#api-key')?.value?.length || 0,
      mcpValid,
      skillPath: document.querySelector('#skill-path')?.textContent || '',
      installCommand: document.querySelector('#skill-install-agents')?.textContent || '',
      seleniumActive: document.querySelector('#automation-selenium')?.classList.contains('active') || false,
      running: Boolean(info.running),
      version: info.version
    };
  })()`;
  const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 12000);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'V15 renderer evaluation failed');
  const value = result.result?.value || {};
  if (value.title !== 'API & MCP' || !value.active || !value.running || value.keyLength < 48 || !value.mcpValid || !value.skillPath.includes('xiaohei-browser') || !value.installCommand.includes('npx skills add') || !value.seleniumActive || value.version !== '15.0.0') throw new Error(JSON.stringify(value));
  console.log(JSON.stringify({ success: true, ...value }));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });