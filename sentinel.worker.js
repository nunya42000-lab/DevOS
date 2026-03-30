import { DevOSSentinel } from './sentinel.js';

const sentinelEngine = new DevOSSentinel();

self.onmessage = (e) => {
  const { code, requestId } = e.data;
  
  try {
    const issues = sentinelEngine.analyze(code);
    self.postMessage({ requestId, issues, status: 'success' });
  } catch (error) {
    self.postMessage({ requestId, status: 'error', message: error.message });
  }
};
