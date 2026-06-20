/**
 * Custom assertions for E2E testing
 */

import { expect } from 'bun:test';
import type { ReviewedUnknown } from '../../../types';

type TestEvent = { event: string; payload: ReviewedUnknown };
type ConsoleEntry = { level: string; args: ReviewedUnknown[] };

/**
 * Assert that no memory leak occurred
 *
 * @param initialSize - Initial size of the registry
 * @param finalSize - Final size of the registry
 * @param tolerance - Acceptable growth (default: 5)
 */
export function expectNoMemoryLeak(initialSize: number, finalSize: number, tolerance = 5): void {
  const leaked = finalSize - initialSize;

  if (leaked > tolerance) {
    console.warn(`⚠️  Memory leak detected: ${leaked} objects leaked (tolerance: ${tolerance})`);
    console.warn(`   Initial size: ${initialSize}, Final size: ${finalSize}`);
  }

  expect(leaked).toBeLessThan(tolerance);
}

/**
 * Assert that an event was received
 *
 * @param events - Array of events
 * @param eventName - Name of the expected event
 * @param payloadMatcher - Optional function to match payload
 */
export function expectEventReceived(
  events: TestEvent[],
  eventName: string,
  payloadMatcher?: (payload: ReviewedUnknown) => boolean
): void {
  const matchingEvents = events.filter((e) => e.event === eventName);

  expect(matchingEvents.length).toBeGreaterThan(0);

  if (payloadMatcher) {
    const matchedPayload = matchingEvents.some((e) => payloadMatcher(e.payload));
    expect(matchedPayload).toBe(true);
  }
}

/**
 * Assert that an event was NOT received
 *
 * @param events - Array of events
 * @param eventName - Name of the event that should not exist
 */
export function expectEventNotReceived(
  events: TestEvent[],
  eventName: string
): void {
  const matchingEvents = events.filter((e) => e.event === eventName);
  expect(matchingEvents.length).toBe(0);
}

/**
 * Assert that events were received in a specific order
 *
 * @param events - Array of events
 * @param expectedOrder - Expected order of event names
 */
export function expectEventsInOrder(
  events: TestEvent[],
  expectedOrder: string[]
): void {
  const actualOrder = events.map((e) => e.event);
  const relevantEvents = actualOrder.filter((name) => expectedOrder.includes(name));

  expect(relevantEvents).toEqual(expectedOrder);
}

/**
 * Assert that a specific number of events were received
 *
 * @param events - Array of events
 * @param eventName - Name of the event
 * @param expectedCount - Expected count
 */
export function expectEventCount(
  events: TestEvent[],
  eventName: string,
  expectedCount: number
): void {
  const matchingEvents = events.filter((e) => e.event === eventName);
  expect(matchingEvents.length).toBe(expectedCount);
}

/**
 * Assert that console output contains a specific message
 *
 * @param consoleOutput - Array of console outputs
 * @param level - Console level ('log', 'warn', 'error')
 * @param messageMatcher - String or regex to match
 */
export function expectConsoleOutput(
  consoleOutput: ConsoleEntry[],
  level: string,
  messageMatcher: string | RegExp
): void {
  const matchingLogs = consoleOutput.filter((log) => log.level === level);

  const found = matchingLogs.some((log) => {
    const message = log.args.join(' ');
    if (typeof messageMatcher === 'string') {
      return message.includes(messageMatcher);
    }
    return messageMatcher.test(message);
  });

  expect(found).toBe(true);
}

/**
 * Assert that no errors were logged to console
 *
 * @param consoleOutput - Array of console outputs
 */
export function expectNoConsoleErrors(
  consoleOutput: ConsoleEntry[]
): void {
  const errors = consoleOutput.filter((log) => log.level === 'error');

  if (errors.length > 0) {
    console.warn('⚠️  Console errors detected:');
    errors.forEach((error, index) => {
      console.warn(`   ${index + 1}. ${error.args.join(' ')}`);
    });
  }

  expect(errors.length).toBe(0);
}

/**
 * Assert that no warnings were logged to console
 *
 * @param consoleOutput - Array of console outputs
 */
export function expectNoConsoleWarnings(
  consoleOutput: ConsoleEntry[]
): void {
  const warnings = consoleOutput.filter((log) => log.level === 'warn');
  expect(warnings.length).toBe(0);
}

/**
 * Assert that a node exists in the receiver
 *
 * @param node - Node to check
 * @param errorMessage - Optional custom error message
 */
// biome-ignore lint/suspicious/noExplicitAny: Test helper accepts any node type
export function expectNodeExists(node: any, errorMessage?: string): void {
  expect(node).toBeDefined();
  expect(node).not.toBeNull();

  if (errorMessage && !node) {
    throw new Error(errorMessage);
  }
}

/**
 * Assert that a node has specific props
 *
 * @param node - Node to check
 * @param expectedProps - Expected props object
 */
// biome-ignore lint/suspicious/noExplicitAny: Test helper accepts any node type
export function expectNodeProps(node: any, expectedProps: Record<string, unknown>): void {
  expectNodeExists(node);

  for (const [key, value] of Object.entries(expectedProps)) {
    expect(node.props[key]).toEqual(value);
  }
}

/**
 * Assert that a function prop exists and is callable
 *
 * @param node - Node to check
 * @param propName - Name of the function prop
 */
// biome-ignore lint/suspicious/noExplicitAny: Test helper accepts any node type
export function expectFunctionProp(node: any, propName: string): void {
  expectNodeExists(node);
  expect(typeof node.props[propName]).toBe('function');
}

/**
 * Assert that multiple function props exist
 *
 * @param node - Node to check
 * @param propNames - Array of function prop names
 */
// biome-ignore lint/suspicious/noExplicitAny: Test helper accepts any node type
export function expectFunctionProps(node: any, propNames: string[]): void {
  expectNodeExists(node);

  for (const propName of propNames) {
    expect(typeof node.props[propName]).toBe('function');
  }
}

/**
 * Assert that an operation completed within a time limit
 *
 * @param operationName - Name of the operation
 * @param duration - Duration in milliseconds
 * @param maxDuration - Maximum acceptable duration in milliseconds
 */
export function expectPerformance(
  operationName: string,
  duration: number,
  maxDuration: number
): void {
  if (duration > maxDuration) {
    console.warn(
      `⚠️  Performance issue: ${operationName} took ${duration}ms (max: ${maxDuration}ms)`
    );
  }

  expect(duration).toBeLessThan(maxDuration);
}

/**
 * Assert that a value is within a range
 *
 * @param value - Value to check
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 */
export function expectInRange(value: number, min: number, max: number): void {
  expect(value).toBeGreaterThanOrEqual(min);
  expect(value).toBeLessThanOrEqual(max);
}

/**
 * Assert that an array contains items matching a predicate
 *
 * @param array - Array to check
 * @param predicate - Predicate function
 * @param expectedCount - Expected number of matching items (default: at least 1)
 */
export function expectArrayContains<T>(
  array: T[],
  predicate: (item: T) => boolean,
  expectedCount = { min: 1, max: Infinity }
): void {
  const matchingItems = array.filter(predicate);
  const count = matchingItems.length;

  expect(count).toBeGreaterThanOrEqual(expectedCount.min);
  if (expectedCount.max !== Infinity) {
    expect(count).toBeLessThanOrEqual(expectedCount.max);
  }
}
