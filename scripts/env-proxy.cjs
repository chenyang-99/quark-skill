'use strict';

// The official CLI creates its own agents. Give those agents the cloud's
// inherited proxy settings without changing the vendor bundle or TLS trust.
const hasProxy = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']
  .some((key) => Boolean(process.env[key]));

if (hasProxy) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 5)) {
    throw new Error('Proxy mode requires Node.js >= 24.5.');
  }
  for (const name of ['node:http', 'node:https']) {
    const transport = require(name);
    const BaseAgent = transport.Agent;
    transport.Agent = class extends BaseAgent {
      constructor(options = {}) {
        super({ ...options, proxyEnv: options.proxyEnv ?? process.env });
      }
    };
    transport.globalAgent = new transport.Agent({ keepAlive: true });
  }
}
