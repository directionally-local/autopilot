// Optional dependency: Playwright is only needed for the browser_fetch tool.
// This declaration allows TypeScript to compile without playwright installed.
declare module "playwright" {
  export interface Request {
    url(): string;
  }

  export interface Route {
    request(): Request;
    abort(errorCode?: string): Promise<void>;
    continue(): Promise<void>;
  }

  export interface Page {
    route(url: string, handler: (route: Route) => Promise<void> | void): Promise<void>;
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
    screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
    evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  }

  export interface Browser {
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }

  export const chromium: {
    launch(options?: { headless?: boolean }): Promise<Browser>;
  };
}
