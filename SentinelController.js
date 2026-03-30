export class SentinelController {
  constructor(workerPath, onResults) {
    this.worker = new Worker(workerPath, { type: 'module' });
    this.onResults = onResults;
    this.debounceTimer = null;
    this.currentRequestId = 0;

    this.worker.onmessage = (e) => {
      if (e.data.requestId === this.currentRequestId) {
        this.onResults(e.data.issues);
      }
    };
  }

  check(code) {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.currentRequestId++;
      this.worker.postMessage({ code, requestId: this.currentRequestId });
    }, 300);
  }

  terminate() {
    this.worker.terminate();
  }
}
