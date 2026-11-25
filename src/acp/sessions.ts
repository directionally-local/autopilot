/**
 * The ACP sessions this process holds, by session id. An editor can open
 * many threads in one agent process; past MAX_SESSIONS the oldest is closed
 * (its turn cancelled, its MCP servers stopped) to bound memory.
 */

export interface StoredSession {
  id: string;
  /** Cancel the running turn, stop MCP servers, release resources. */
  dispose(): void;
}

export const MAX_SESSIONS = 64;

export class SessionStore<S extends StoredSession> {
  private readonly sessions = new Map<string, S>();

  constructor(private readonly max = MAX_SESSIONS) {}

  get(id: string): S | undefined {
    return this.sessions.get(id);
  }

  set(session: S): void {
    const existing = this.sessions.get(session.id);
    if (existing && existing !== session) existing.dispose();
    this.sessions.delete(session.id);
    while (this.sessions.size >= this.max) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.get(oldest)?.dispose();
      this.sessions.delete(oldest);
    }
    this.sessions.set(session.id, session);
  }

  delete(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.dispose();
    return this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}
