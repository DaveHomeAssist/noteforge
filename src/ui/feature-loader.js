// CSS preload failures require reload: bundlers may retain the failed link.
const transportFailure = (error) =>
  error instanceof TypeError &&
  /fetch|network|loading.*module|load failed|dynamically imported|importing a module/i.test(error.message);

/** Successful loads outlive requests; a failed load gets at most one explicit retry. */
export class FeatureLoader {
  constructor() {
    this.entries = new Map();
  }
  load(key, factory, retry = false) {
    let entry = this.entries.get(key);
    if (retry && entry?.error && entry.recoverable && entry.attempts < 2) {
      entry = { attempts: entry.attempts };
      this.entries.set(key, entry);
    }
    if (!entry) {
      entry = { attempts: 0 };
      this.entries.set(key, entry);
    }
    if (!entry.promise) {
      entry.attempts++;
      entry.promise = Promise.resolve()
        .then(factory)
        .catch((error) => {
          entry.error = error;
          entry.recoverable = transportFailure(error);
          throw error;
        });
    }
    return entry.promise;
  }
  canRetry(key) {
    const entry = this.entries.get(key);
    return Boolean(entry?.error && entry.recoverable && entry.attempts < 2);
  }
}
