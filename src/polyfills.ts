// Simple polyfills for Node.js compatibility in Azure DevOps agents

// Ensure fetch is available
if (typeof globalThis.fetch === 'undefined') {
  globalThis.fetch = require('node-fetch');
}

// Note: ReadableStream compatibility issues are handled by using node-fetch v2
// which doesn't rely on ReadableStream for older Node.js versions
