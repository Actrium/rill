/**
 * TurnGate (Milestone B web side) — serializes ALL guest-eval entry so an
 * outstanding Asyncify suspend is never re-entered.
 *
 * Why this exists, and why it sits at eval-entry rather than message dispatch:
 * the worker's {@link TimerManager} fires guest callbacks INSIDE the worker event
 * loop (a `setTimeout` the engine owns), not via a `postMessage` from the main
 * thread. So gating only inbound worker messages would miss timer-driven guest
 * turns entirely. The gate must therefore wrap every path that calls into the
 * guest realm.
 *
 * The hazard it guards: with the QuickJS-asyncify debug build (Milestone A), a
 * breakpoint suspends the C stack mid-interpreter and eval returns a still-pending
 * Promise. If a second guest turn were dispatched into the runtime while the first
 * is parked at a breakpoint, the interpreter would be re-entered on top of a
 * suspended stack — undefined behaviour. The gate makes eval-entry strictly FIFO
 * and refuses to drain while a suspend is outstanding.
 *
 * This class is intentionally free of any worker/wasm dependency so it is a pure,
 * headless-unit-testable state machine (drive it with a fake deferred `runTurn`).
 */

/** A queued guest turn awaiting its slot in the gate. */
interface QueuedTurn {
  invoke: () => void;
}

export class TurnGate {
  /** True between `onSuspend()` and `onResume()` — a breakpoint pause is outstanding. */
  #suspended = false;
  /** True while a turn's `fn` has started and its result Promise has not settled. */
  #inFlight = false;
  /** FIFO of turns that have not yet been dispatched. */
  #queue: QueuedTurn[] = [];

  /** Whether a suspend is currently outstanding. */
  get isSuspended(): boolean {
    return this.#suspended;
  }

  /** Whether a turn is currently running (started, not yet settled). */
  get isBusy(): boolean {
    return this.#inFlight;
  }

  /** Number of turns queued but not yet dispatched. */
  get pending(): number {
    return this.#queue.length;
  }

  /**
   * Enqueue a guest turn. `fn` is only invoked once the gate is idle — not
   * suspended and with no other turn in flight — and turns run in strict FIFO
   * order. Resolves/rejects with `fn`'s result. A synchronous throw from `fn`
   * rejects the returned promise (and still frees the gate for the next turn).
   */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        invoke: () => {
          this.#inFlight = true;
          let result: T | Promise<T>;
          try {
            result = fn();
          } catch (err) {
            this.#settle(() => reject(err));
            return;
          }
          Promise.resolve(result).then(
            (value) => this.#settle(() => resolve(value)),
            (err) => this.#settle(() => reject(err))
          );
        },
      });
      this.#drain();
    });
  }

  /**
   * Mark that the in-flight turn has suspended at a breakpoint. New turns keep
   * queueing but none is dispatched until {@link onResume}. Idempotent.
   */
  onSuspend(): void {
    this.#suspended = true;
  }

  /**
   * Clear an outstanding suspend and resume draining. Note this does NOT settle
   * the parked turn — that turn's own result Promise settles when the underlying
   * Asyncify rewind completes; this only re-opens the gate for queued turns.
   */
  onResume(): void {
    if (!this.#suspended) return;
    this.#suspended = false;
    this.#drain();
  }

  /** Free the gate and settle the just-finished turn, then dispatch the next. */
  #settle(settleOne: () => void): void {
    this.#inFlight = false;
    settleOne();
    this.#drain();
  }

  /** Dispatch the next queued turn iff the gate is idle. */
  #drain(): void {
    if (this.#suspended || this.#inFlight) return;
    const next = this.#queue.shift();
    if (!next) return;
    next.invoke();
  }
}
