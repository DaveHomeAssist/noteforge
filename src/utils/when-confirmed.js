/**
 * Run `run` once `answer` (a boolean, or a Promise of one) is true. A plain
 * `true` runs it synchronously, so callers can inject a synchronous confirmer
 * (tests) while the app passes the asynchronous in-app dialog.
 */
export function whenConfirmed(answer, run) {
  if (answer === true) return run();
  if (answer && typeof answer.then === 'function') return answer.then((ok) => (ok === true ? run() : undefined));
  return undefined;
}
