/**
 * Hierarchical abort scopes for Autopilot turn lifecycle.
 *
 * Each turn gets a child scope from the session scope.
 * Each operation (bash, readSSE, etc.) gets a child scope from the turn scope.
 * Aborting a parent automatically aborts all descendants.
 */

export class AbortScope {
  private controller: AbortController;
  private parent: AbortScope | undefined;
  private children: Set<AbortScope> = new Set();
  private parentListener: (() => void) | undefined;
  private _isAborted = false;
  private _reason: string | undefined;

  constructor(parent?: AbortScope) {
    this.controller = new AbortController();
    this.parent = parent;

    if (parent) {
      this.parentListener = () => {
        this.abort(parent.reason ?? "parent_aborted");
      };
      parent.signal.addEventListener("abort", this.parentListener, { once: true });
      parent.children.add(this);
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isAborted(): boolean {
    return this._isAborted;
  }

  get reason(): string | undefined {
    return this._reason;
  }

  abort(reason?: string): void {
    if (this._isAborted) return;
    this._isAborted = true;
    this._reason = reason;

    // Abort all children first (depth-first)
    for (const child of this.children) {
      child.abort(reason ?? "parent_aborted");
    }
    this.children.clear();

    // Then abort self
    this.controller.abort(reason);

    // Clean up parent listener
    if (this.parent && this.parentListener) {
      this.parent.signal.removeEventListener("abort", this.parentListener);
      this.parent.children.delete(this);
      this.parent = undefined;
    }
  }

  createChild(): AbortScope {
    if (this._isAborted) {
      // Creating a child from an already-aborted scope returns an immediately-aborted child
      const child = new AbortScope();
      child._isAborted = true;
      child._reason = this._reason ?? "parent_already_aborted";
      child.controller.abort(child._reason);
      return child;
    }
    return new AbortScope(this);
  }

  /** Detach from parent without aborting. Useful when a child outlives its parent. */
  detach(): void {
    if (this.parent && this.parentListener) {
      this.parent.signal.removeEventListener("abort", this.parentListener);
      this.parent.children.delete(this);
      this.parent = undefined;
    }
  }
}
