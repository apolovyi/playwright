/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Several MCP clients share one bound persistent browser: each sees and closes only the pages it opened,
// and the owner closes them when the client's pipe connection ends, however it ends.

import child_process from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { test, expect } from './fixtures';
import { tools } from '../../packages/playwright-core/lib/coreBundle';

import type { Browser } from 'playwright';

type Owner = { endpoint: string, stop: () => Promise<void> };
type Agent = { client: Client, browser: Browser, close: () => Promise<void> };

test.skip(({ mcpBrowser }) => !['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Binds a Chromium-based persistent browser');

const playwrightCore = path.dirname(require.resolve('playwright-core/package.json'));

async function startOwner(testInfo: { outputPath: (...segments: string[]) => string }, channel: string | undefined, env: NodeJS.ProcessEnv = {}): Promise<Owner> {
  const script = testInfo.outputPath('owner.cjs');
  await fs.writeFile(script, `
    const { chromium } = require(${JSON.stringify(playwrightCore)});
    (async () => {
      const context = await chromium.launchPersistentContext(${JSON.stringify(testInfo.outputPath('profile'))}, { channel: ${JSON.stringify(channel)}, headless: true });
      const { endpoint } = await context.browser().bind('shared-browser-test');
      process.stdout.write(JSON.stringify({ endpoint }) + '\\n');
      process.stdin.on('end', async () => { await context.close(); process.exit(0); });
      process.stdin.resume();
    })();
  `);
  const child = child_process.spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const endpoint = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', data => {
      buffer += data;
      if (buffer.includes('\n'))
        resolve(JSON.parse(buffer).endpoint);
    });
    child.once('exit', code => reject(new Error(`owner exited with ${code}`)));
  });
  return { endpoint, stop: async () => { child.stdin.end(); await exited; } };
}

async function connectAgent(endpoint: string): Promise<Agent> {
  const browser = await chromium.connect(endpoint);
  const server = await tools.createConnection({ browser: { isolated: false }, ownTabsOnly: true }, async () => browser.contexts()[0]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'agent', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, browser, close: async () => { await client.close(); await browser.close(); } };
}

// A fresh connection per look, so that the observer never holds pages or keeps a silent connection of its own.
async function openUrls(endpoint: string): Promise<string[]> {
  const browser = await chromium.connect(endpoint);
  const urls = browser.contexts()[0].pages().map(page => page.url());
  await browser.close();
  return urls.sort();
}

async function tabList(agent: Agent): Promise<string> {
  const result = await agent.client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  return (result.content as { type: string, text: string }[]).map(part => part.text).join('\n');
}

test('an agent never adopts pages it did not open', async ({ server, mcpBrowser }, testInfo) => {
  server.setContent('/a', '<title>A</title>', 'text/html');
  server.setContent('/b', '<title>B</title>', 'text/html');
  const owner = await startOwner(testInfo, mcpBrowser === 'chromium' ? undefined : mcpBrowser);
  const a = await connectAgent(owner.endpoint);
  await a.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/a' } });
  const b = await connectAgent(owner.endpoint);
  expect(await b.client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })).toHaveResponse({ result: expect.not.stringContaining('/a') });
  await b.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/b' } });

  expect(await openUrls(owner.endpoint)).toEqual(['about:blank', server.PREFIX + '/a', server.PREFIX + '/b']);
  expect(await tabList(a)).not.toContain('/b');
  expect(await tabList(b)).not.toContain('/a');
  expect(await a.client.callTool({ name: 'browser_snapshot' })).toHaveResponse({ page: expect.stringContaining('/a') });

  await a.close();
  await b.close();
  await owner.stop();
});

test('pages opened from an agent tab belong to that agent, noopener included', async ({ server, mcpBrowser }, testInfo) => {
  server.setContent('/openers', `
    <a href="/child?blank" target=_blank>blank</a>
    <a href="/child?noopener" target=_blank rel=noopener>noopener</a>
    <a href="/child?noreferrer" target=_blank rel=noreferrer>noreferrer</a>
    <button onclick="window.open('/child?open')">open</button>
    <button onclick="window.open('/child?open-noopener', '_blank', 'noopener')">open noopener</button>
    <form action="/child" target=_blank><input type=hidden name=form><button>form</button></form>
  `, 'text/html');
  server.setContent('/child', '<title>child</title>', 'text/html');
  const owner = await startOwner(testInfo, mcpBrowser === 'chromium' ? undefined : mcpBrowser);
  const opener = await connectAgent(owner.endpoint);
  const bystander = await connectAgent(owner.endpoint);
  await bystander.client.callTool({ name: 'browser_navigate', arguments: { url: server.EMPTY_PAGE } });
  await opener.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/openers' } });
  await opener.client.callTool({ name: 'browser_evaluate', arguments: { function: `() => document.querySelectorAll('a, button').forEach(element => element.click())` } });

  const variants = ['blank', 'noopener', 'noreferrer', 'open', 'open-noopener', 'form='];
  await expect.poll(async () => (await openUrls(owner.endpoint)).filter(url => url.includes('/child')).length).toBe(variants.length);
  const openerTabs = await tabList(opener);
  for (const variant of variants)
    expect(openerTabs).toContain(`/child?${variant}`);
  expect(await tabList(bystander)).not.toContain('/child');

  await opener.close();
  await expect.poll(() => openUrls(owner.endpoint)).toEqual(['about:blank', server.EMPTY_PAGE]);
  await bystander.close();
  await owner.stop();
});

test('an agent tab closes when its connection closes cleanly', async ({ server, mcpBrowser }, testInfo) => {
  server.setContent('/a', '<title>A</title>', 'text/html');
  const owner = await startOwner(testInfo, mcpBrowser === 'chromium' ? undefined : mcpBrowser);
  const a = await connectAgent(owner.endpoint);
  await a.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/a' } });
  expect(await openUrls(owner.endpoint)).toEqual(['about:blank', server.PREFIX + '/a']);

  // Disconnecting without disposing the MCP backend is what an exiting stdio server does.
  await a.browser.close();
  await expect.poll(() => openUrls(owner.endpoint)).toEqual(['about:blank']);
  await owner.stop();
});

test('an agent tab closes when its process is killed', async ({ server, mcpBrowser }, testInfo) => {
  server.setContent('/killed', '<title>killed</title>', 'text/html');
  const owner = await startOwner(testInfo, mcpBrowser === 'chromium' ? undefined : mcpBrowser);
  const script = testInfo.outputPath('agent.cjs');
  await fs.writeFile(script, `
    const { chromium } = require(${JSON.stringify(playwrightCore)});
    const { tools } = require(${JSON.stringify(path.join(playwrightCore, 'lib/coreBundle'))});
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    (async () => {
      const browser = await chromium.connect(${JSON.stringify(owner.endpoint)});
      const server = await tools.createConnection({ browser: { isolated: false }, ownTabsOnly: true }, async () => browser.contexts()[0]);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'agent', version: '1.0.0' });
      await client.connect(clientTransport);
      await client.callTool({ name: 'browser_navigate', arguments: { url: ${JSON.stringify(server.PREFIX + '/killed')} } });
      process.stdout.write('READY\\n');
      setInterval(() => {}, 1000);
    })();
  `);
  const child = child_process.spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>(resolve => child.stdout.on('data', data => data.toString().includes('READY') && resolve()));
  expect(await openUrls(owner.endpoint)).toEqual(['about:blank', server.PREFIX + '/killed']);

  child.kill('SIGKILL');
  await expect.poll(() => openUrls(owner.endpoint)).toEqual(['about:blank']);
  await owner.stop();
});

test('the owner drops a silent connection and keeps a busy one', async ({ server, mcpBrowser }, testInfo) => {
  server.setContent('/silent', '<title>silent</title>', 'text/html');
  server.setContent('/busy', '<title>busy</title>', 'text/html');
  const owner = await startOwner(testInfo, mcpBrowser === 'chromium' ? undefined : mcpBrowser, { PWTEST_PIPE_SILENT_CONNECTION_TIMEOUT: '1500' });
  const silent = await connectAgent(owner.endpoint);
  const busy = await connectAgent(owner.endpoint);
  const silentDisconnected = new Promise(resolve => silent.browser.once('disconnected', resolve));
  await silent.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/silent' } });
  await busy.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/busy' } });

  const until = Date.now() + 4000;
  while (Date.now() < until) {
    expect(await busy.client.callTool({ name: 'browser_snapshot' })).toHaveResponse({ page: expect.stringContaining('/busy') });
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  await silentDisconnected;
  expect(busy.browser.isConnected()).toBe(true);
  expect(await openUrls(owner.endpoint)).toEqual(['about:blank', server.PREFIX + '/busy']);

  await busy.close();
  await silent.client.close();
  await owner.stop();
});
