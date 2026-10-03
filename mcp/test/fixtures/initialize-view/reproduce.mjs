import { writeFile } from 'node:fs/promises';
import { initialize, startFixture, startProxy } from './harness.mjs';
const [executable, output] = process.argv.slice(2);
if (!executable || !output) throw new Error('Usage: node reproduce.mjs <installed proxy.js> <capture.json>');
const fixture = await startFixture();
const proxy = startProxy(executable, fixture.url);
try {
  await proxy.request(initialize('setup'));
  proxy.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await proxy.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await writeFile(output, `${JSON.stringify({ executable, stdio: proxy.traffic, http: fixture.traffic }, null, 2)}\n`);
  console.log(JSON.stringify({ revision: listed.result._meta.revision, tools: listed.result.tools.length, capture: output }));
} finally {
  await proxy.close();
  await fixture.close();
}
