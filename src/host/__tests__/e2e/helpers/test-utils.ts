/**
 * Test utility functions for E2E testing
 */

import type { Receiver } from '../../../receiver';
import type { ReviewedUnknown } from '../../../types';

type TestEvent = { event: string; payload: ReviewedUnknown };

/**
 * Wait for a condition to become true
 *
 * @param condition - Function that returns true when condition is met
 * @param timeout - Maximum time to wait in milliseconds (default: 5000)
 * @param interval - Check interval in milliseconds (default: 50)
 * @throws Error if timeout is reached
 */
export async function waitFor(
  condition: () => boolean,
  timeout = 5000,
  interval = 50
): Promise<void> {
  const startTime = Date.now();

  while (!condition()) {
    if (Date.now() - startTime > timeout) {
      throw new Error(`Timeout waiting for condition after ${timeout}ms`);
    }
    await wait(interval);
  }
}

/**
 * Wait for a fixed amount of time
 *
 * @param ms - Time to wait in milliseconds
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find a node by testID in the receiver
 *
 * @param receiver - Receiver instance
 * @param testID - Test ID to search for
 * @returns Node instance or undefined if not found
 */
// biome-ignore lint/suspicious/noExplicitAny: Test utility returns dynamic operation type
export function findNodeByTestId(receiver: Receiver, testID: string): any {
  return receiver.findByTestId(testID);
}

/**
 * Find all nodes by type in the receiver
 *
 * @param receiver - Receiver instance
 * @param type - Node type to search for (e.g., 'View', 'Text')
 * @returns Array of node instances
 */
// biome-ignore lint/suspicious/noExplicitAny: Test utility returns dynamic operation type
export function findNodesByType(receiver: Receiver, type: string): any[] {
  return receiver.findNodesByType(type);
}

/**
 * Get all nodes from the receiver
 *
 * @param receiver - Receiver instance
 * @returns Array of all node instances
 */
// biome-ignore lint/suspicious/noExplicitAny: Test helper returns nodes with dynamic types
export function getAllNodes(receiver: Receiver): any[] {
  return receiver.getNodes();
}

/**
 * Wait for an event to be received
 *
 * @param events - Array of events to monitor
 * @param eventName - Name of the event to wait for
 * @param timeout - Maximum time to wait in milliseconds (default: 5000)
 * @returns The event object
 */
export async function waitForEvent(
  events: TestEvent[],
  eventName: string,
  timeout = 5000
): Promise<TestEvent> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const event = events.find((e) => e.event === eventName);
    if (event) {
      return event;
    }
    await wait(50);
  }

  throw new Error(`Timeout waiting for event '${eventName}' after ${timeout}ms`);
}

/**
 * Wait for multiple events to be received
 *
 * @param events - Array of events to monitor
 * @param eventNames - Array of event names to wait for
 * @param timeout - Maximum time to wait in milliseconds (default: 5000)
 * @returns Array of event objects
 */
export async function waitForEvents(
  events: TestEvent[],
  eventNames: string[],
  timeout = 5000
): Promise<TestEvent[]> {
  const startTime = Date.now();
  const foundEvents: TestEvent[] = [];

  while (Date.now() - startTime < timeout) {
    for (const eventName of eventNames) {
      if (foundEvents.some((e) => e.event === eventName)) {
        continue;
      }
      const event = events.find((e) => e.event === eventName);
      if (event) {
        foundEvents.push(event);
      }
    }

    if (foundEvents.length === eventNames.length) {
      return foundEvents;
    }

    await wait(50);
  }

  const missing = eventNames.filter((name) => !foundEvents.some((e) => e.event === name));
  throw new Error(`Timeout waiting for events [${missing.join(', ')}] after ${timeout}ms`);
}

/**
 * Clear all events from an array
 *
 * @param events - Array of events to clear
 */
export function clearEvents(events: TestEvent[]): void {
  events.length = 0;
}

/**
 * Get the last event from an array
 *
 * @param events - Array of events
 * @returns The last event or undefined
 */
export function getLastEvent(
  events: TestEvent[]
): TestEvent | undefined {
  return events[events.length - 1];
}

/**
 * Get all events with a specific name
 *
 * @param events - Array of events
 * @param eventName - Name of the event
 * @returns Array of matching events
 */
export function getEventsByName(
  events: TestEvent[],
  eventName: string
): TestEvent[] {
  return events.filter((e) => e.event === eventName);
}

/**
 * Retry a function until it succeeds or timeout
 *
 * @param fn - Function to retry
 * @param options - Retry options
 * @returns Result of the function
 */
export async function retry<T>(
  fn: () => T | Promise<T>,
  options: {
    maxAttempts?: number;
    delay?: number;
    timeout?: number;
  } = {}
): Promise<T> {
  const { maxAttempts = 3, delay = 100, timeout = 5000 } = options;
  const startTime = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() - startTime > timeout) {
      throw new Error(`Retry timeout after ${timeout}ms`);
    }

    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }
      await wait(delay);
    }
  }

  throw new Error('Retry failed');
}

/**
 * Simulate a press event on a node
 * Works with both Mock component objects and NodeInstance objects
 *
 * @param node - Node instance or mock component
 * @param propName - Name of the callback prop (default: 'onPress')
 * @returns Result of the callback
 */
// biome-ignore lint/suspicious/noExplicitAny: Test helper accepts any node type
export async function simulatePress(node: any, propName = 'onPress'): Promise<ReviewedUnknown> {
  if (!node) {
    throw new Error('Node is null or undefined');
  }

  // If node has __testPress (mock component), use it
  if (typeof node.__testPress === 'function') {
    return await node.__testPress();
  }

  // Otherwise, call the callback prop directly (NodeInstance)
  const callback = node.props?.[propName];
  if (typeof callback === 'function') {
    return await callback();
  }

  throw new Error(`No callback function found at props.${propName}`);
}

/**
 * Get text content of a node (recursively collects text from all __TEXT__ children)
 *
 * @param receiver - Receiver instance
 * @param node - Node instance
 * @returns Combined text content of all text children
 */
// biome-ignore lint/suspicious/noExplicitAny: Test helper accepts any node type
export function getNodeText(receiver: Receiver, node: any): string {
  if (!node) return '';

  // If this is a __TEXT__ node, return its text
  if (node.type === '__TEXT__') {
    return String(node.props.text || '');
  }

  // Otherwise, recursively collect text from children
  if (Array.isArray(node.children)) {
    return node.children
      .map((childId: number) => {
        const child = receiver.getNodes().find((n) => n.id === childId);
        return getNodeText(receiver, child);
      })
      .join('');
  }

  return '';
}
