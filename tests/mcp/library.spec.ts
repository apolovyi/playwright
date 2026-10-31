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
import child_process from 'child_process';
import fs from 'fs/promises';
import { test, expect } from './fixtures';

test('library can be used from CommonJS', { annotation: { type: 'issue', description: 'https://github.com/microsoft/playwright-mcp/issues/456' } }, async ({}, testInfo) => {
  const file = testInfo.outputPath('main.cjs');
  await fs.writeFile(file, `
    import('playwright-core/lib/coreBundle')
      .then(({ tools }) => tools.createConnection())
      .then(() => console.log('OK'));
 `);
  expect(child_process.execSync(`node ${file}`, { encoding: 'utf-8' })).toContain('OK');
});

test('embedded connection lets Node exit naturally after a completed action', async ({ server, mcpBrowser }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Launches a Chromium-based browser');
  server.setContent('/', `<button onclick="fetch('/ping')">Ping</button>`, 'text/html');
  server.setContent('/ping', 'pong', 'text/plain');
  const file = testInfo.outputPath('main.cjs');
  await fs.writeFile(file, `
    const { chromium } = require('playwright-core');
    const { tools } = require('playwright-core/lib/coreBundle');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    (async () => {
      const browser = await chromium.launch({ channel: ${JSON.stringify(mcpBrowser === 'chromium' ? undefined : mcpBrowser)} });
      const context = await browser.newContext();
      const server = await tools.createConnection({}, async () => context);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(clientTransport);
      await client.callTool({ name: 'browser_navigate', arguments: { url: ${JSON.stringify(server.PREFIX)} } });
      await client.callTool({ name: 'browser_click', arguments: { element: 'Ping button', target: 'e2' } });
      await client.close();
      await server.close();
      await browser.close();
      process.stdout.write('CLOSED\\n');
    })();
  `);
  const child = child_process.spawn('node', [file], { stdio: ['ignore', 'pipe', 'inherit'] });
  let closedAt: number | undefined;
  child.stdout.on('data', data => {
    if (data.toString().includes('CLOSED'))
      closedAt = Date.now();
  });
  const exitCode = await new Promise(resolve => child.on('exit', resolve));
  expect(exitCode).toBe(0);
  expect(closedAt).toBeDefined();
  // A request-tracking timer that outlives the action would hold the process for up to five seconds.
  expect(Date.now() - closedAt!).toBeLessThan(2000);
});

test('embedded connection lets Node exit naturally when the client advertises roots', async ({ server, mcpBrowser }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Launches a Chromium-based browser');
  server.setContent('/', `<p>roots</p>`, 'text/html');
  const file = testInfo.outputPath('main.cjs');
  await fs.writeFile(file, `
    const { chromium } = require('playwright-core');
    const { tools } = require('playwright-core/lib/coreBundle');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { ListRootsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
    (async () => {
      const browser = await chromium.launch({ channel: ${JSON.stringify(mcpBrowser === 'chromium' ? undefined : mcpBrowser)} });
      const context = await browser.newContext();
      const server = await tools.createConnection({}, async () => context);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: { roots: {} } });
      client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [] }));
      await client.connect(clientTransport);
      await client.callTool({ name: 'browser_navigate', arguments: { url: ${JSON.stringify(server.PREFIX)} } });
      await client.close();
      await server.close();
      await browser.close();
      process.stdout.write('CLOSED\\n');
    })();
  `);
  const child = child_process.spawn('node', [file], { stdio: ['ignore', 'pipe', 'inherit'] });
  let closedAt: number | undefined;
  child.stdout.on('data', data => {
    if (data.toString().includes('CLOSED'))
      closedAt = Date.now();
  });
  const exitCode = await new Promise(resolve => child.on('exit', resolve));
  expect(exitCode).toBe(0);
  expect(closedAt).toBeDefined();
  // The wait for the client's roots must not leave its five-second fallback timer armed.
  expect(Date.now() - closedAt!).toBeLessThan(2000);
});
