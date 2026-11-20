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

// The per-user server registry and socket directory belong to the browsers the developer is running.
// A browser bound by a test is published in that test's own directories instead.

import fs from 'fs';
import path from 'path';

import { test, expect } from './fixtures';

test('a browser bound by a test is published in the test\'s own registry and socket directory', async ({ client, server }, testInfo) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  const registry = testInfo.outputPath('registry');
  const descriptors = fs.readdirSync(registry).map(name => JSON.parse(fs.readFileSync(path.join(registry, name), 'utf8')));
  expect(descriptors.map(descriptor => descriptor.title)).toEqual(['test']);
  expect(descriptors[0].endpoint).toContain(process.env.PWTEST_SOCKETS_DIR + path.sep);
});
