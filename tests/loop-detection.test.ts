import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { LoopDetector } from '../dist/engine/loop-detector.js';

describe('Loop & Oscillation Detection Circuit Breaker', () => {
  test('Trips breaker when same tool with identical args fails consecutively', () => {
    const detector = new LoopDetector(10, 2);

    // Call 1 fails
    detector.recordAction('bash', { command: 'npm test' }, true);
    assert.strictEqual(detector.checkCircuitBreaker().tripped, false);

    // Call 2 with same command fails -> should trip
    detector.recordAction('bash', { command: 'npm test' }, true);
    const breaker = detector.checkCircuitBreaker();
    assert.strictEqual(breaker.tripped, true);
    assert.match(breaker.reason!, /Detected dead-loop/);
  });

  test('Trips breaker when detecting edit oscillation (A -> B -> A)', () => {
    const detector = new LoopDetector(10, 3);

    // A: edit auth.ts with change A
    detector.recordAction('edit', { filePath: 'auth.ts', newStr: 'const role = "admin";' }, false);
    assert.strictEqual(detector.checkCircuitBreaker().tripped, false);

    // B: edit auth.ts revert to change B
    detector.recordAction('edit', { filePath: 'auth.ts', newStr: 'const role = "user";' }, false);
    assert.strictEqual(detector.checkCircuitBreaker().tripped, false);

    // A again: edit auth.ts back to change A
    detector.recordAction('edit', { filePath: 'auth.ts', newStr: 'const role = "admin";' }, false);
    const breaker = detector.checkCircuitBreaker();
    assert.strictEqual(breaker.tripped, true);
    assert.match(breaker.reason!, /Detected cognitive oscillation/);
  });

  test('Trips breaker when exceeding max turn step budget', () => {
    const detector = new LoopDetector(3, 2);

    detector.recordAction('read', { filePath: 'f1.ts' }, false);
    detector.recordAction('read', { filePath: 'f2.ts' }, false);
    assert.strictEqual(detector.checkCircuitBreaker().tripped, false);

    detector.recordAction('read', { filePath: 'f3.ts' }, false);
    const breaker = detector.checkCircuitBreaker();
    assert.strictEqual(breaker.tripped, true);
    assert.match(breaker.reason!, /Turn step budget exhausted/);
  });
});
