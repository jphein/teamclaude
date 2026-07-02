import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLogThrottle } from '../src/log-throttle.js';

test('the first occurrence of a key is allowed through', () => {
  const throttle = makeLogThrottle({ windowMs: 1000, now: () => 0 });
  assert.deepEqual(throttle('k'), { log: true, suppressed: 0 });
});

test('repeats within the window are suppressed and counted', () => {
  let clock = 0;
  const throttle = makeLogThrottle({ windowMs: 1000, now: () => clock });
  assert.equal(throttle('k').log, true);
  assert.deepEqual(throttle('k'), { log: false, suppressed: 1 });
  assert.deepEqual(throttle('k'), { log: false, suppressed: 2 });
});

test('after the window elapses it logs again and reports how many were suppressed', () => {
  let clock = 0;
  const throttle = makeLogThrottle({ windowMs: 1000, now: () => clock });
  throttle('k'); throttle('k'); throttle('k'); // 1 logged, 2 suppressed
  clock = 1500;                                 // window has passed
  assert.deepEqual(throttle('k'), { log: true, suppressed: 2 });
  assert.deepEqual(throttle('k'), { log: false, suppressed: 1 }); // counter resets after the re-log
});

test('distinct keys are throttled independently', () => {
  const throttle = makeLogThrottle({ windowMs: 1000, now: () => 0 });
  assert.equal(throttle('a').log, true);
  assert.equal(throttle('b').log, true);  // a different key still logs
  assert.equal(throttle('a').log, false); // the first key is now throttled
});
