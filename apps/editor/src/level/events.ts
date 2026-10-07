/**
 * Tiny synchronous event emitter used by the level model. Pure TypeScript so it
 * runs in Node tests and Web Workers.
 */
export type Listener<T> = (value: T) => void;

export class Emitter<T> {
  private listeners: Listener<T>[] = [];

  /** `onError` receives listener exceptions (default: console.error). */
  constructor(
    private readonly onError: (err: unknown) => void = (err) => console.error("[level] listener failed", err),
  ) {}

  /** Subscribe; returns an unsubscribe function. */
  on(listener: Listener<T>): () => void {
    this.listeners.push(listener);
    return () => this.off(listener);
  }

  off(listener: Listener<T>): void {
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  /**
   * Deliver to every listener. A throwing listener never stops the others or
   * corrupts the caller; its error goes to `onError`.
   */
  emit(value: T): void {
    // Copy so listeners may unsubscribe while being called.
    for (const l of this.listeners.slice()) {
      try {
        l(value);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  get size(): number {
    return this.listeners.length;
  }

  clear(): void {
    this.listeners = [];
  }
}

/** Default session clock: ms since page/process start. */
export const defaultClock = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
