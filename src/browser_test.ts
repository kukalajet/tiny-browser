// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { close, launch } from "./browser.ts";

// Helpers and fakes

class FakeChildProcess {
  #resolveStatus!: (value: unknown) => void;
  #rejectStatus!: (reason?: unknown) => void;
  status: Promise<unknown>;
  killedWith: string | null = null;
  mode: "ok" | "notfound" | "other";

  constructor(mode: "ok" | "notfound" | "other" = "ok") {
    this.mode = mode;
    this.status = new Promise((resolve, reject) => {
      this.#resolveStatus = resolve;
      this.#rejectStatus = reject;
    });
  }

  kill(signal: Deno.Signal) {
    // Resolve status immediately to keep tests fast, regardless of outcome
    this.killedWith = String(signal);
    this.#resolveStatus({ code: 0, success: true });

    if (this.mode === "notfound") {
      throw new Deno.errors.NotFound("process not found");
    }
    if (this.mode === "other") {
      throw new Error("unexpected kill error");
    }
  }
}

class FakeCommand {
  static constructed: Array<{ path: string; options: any }> = [];
  static spawnBehavior: "ok" | "notfound" | "other" = "ok";
  static versionCheckCode: number = 0;

  path: string;
  options: any;

  constructor(path: string, options: any) {
    this.path = path;
    this.options = options;
    FakeCommand.constructed.push({ path, options });
  }

  // Used by checkPath() in browser.ts
  // deno-lint-ignore require-await
  async output() {
    const code = FakeCommand.versionCheckCode;
    return { code, success: code === 0 } as unknown as Deno.CommandOutput;
  }

  // Used by launch() in browser.ts
  spawn(): Deno.ChildProcess {
    const child = new FakeChildProcess(
      FakeCommand.spawnBehavior,
    ) as unknown as Deno.ChildProcess;
    return child;
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  url: string;
  sent: string[] = [];

  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.onopen?.(new Event("open"));
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new Event("close"));
  }
}

function makeFetchStub(wsUrl: string) {
  let callCount = 0;
  const stub = (_input: Request | URL | string, _init?: RequestInit) => {
    callCount++;
    return Promise.resolve({
      ok: true,
      // deno-lint-ignore require-await
      async json() {
        return { webSocketDebuggerUrl: wsUrl };
      },
    } as Response);
  };
  (stub as any).getCallCount = () => callCount;
  return stub as typeof fetch & { getCallCount: () => number };
}

// Tests

Deno.test("browser", async (t) => {
  await t.step(
    "launch - spawns headless browser, retrieves WS URL, and returns connected client",
    async () => {
      // Save originals
      const OriginalCommand = Deno.Command;
      const originalFetch = globalThis.fetch;
      const OriginalWebSocket = globalThis.WebSocket;

      // Install fakes
      const wsUrl = "ws://127.0.0.1:9222/devtools/browser/test-abc";
      const fetchStub = makeFetchStub(wsUrl);
      (globalThis as any).fetch = fetchStub;
      (globalThis as any).WebSocket =
        FakeWebSocket as unknown as typeof WebSocket;
      (Deno as any).Command = FakeCommand as unknown as typeof Deno.Command;

      try {
        FakeCommand.constructed.length = 0;

        const browser = await launch();

        // Validate shape
        assert(browser.process, "process should be present");
        assert(browser.client, "client should be present");
        assertEquals(
          browser.webSocketUrl,
          wsUrl,
          "webSocketUrl should match the version endpoint",
        );

        // Verify that a '--version' check was attempted (for finding Chrome)
        const versionChecks = FakeCommand.constructed.filter((c) =>
          Array.isArray(c.options?.args) &&
          c.options.args.length === 1 &&
          c.options.args[0] === "--version"
        );
        assert(
          versionChecks.length >= 1,
          "should invoke Command to check browser version",
        );

        // Verify that Chrome spawn was configured with headless and devtools port 9222
        const spawnConfigs = FakeCommand.constructed.filter((c) =>
          Array.isArray(c.options?.args) &&
          c.options.args.some((a: string) => a === "--headless") &&
          c.options.args.some((a: string) =>
            a.startsWith("--remote-debugging-port=9222")
          )
        );
        assert(
          spawnConfigs.length >= 1,
          "should invoke Command with headless and remote-debugging-port=9222",
        );

        // Verify that a WebSocket connection attempt was made
        assertEquals(FakeWebSocket.instances.length, 1);
        assertEquals(FakeWebSocket.instances[0].url, wsUrl);

        // Cleanup: ensure close() works on the launched browser
        await close(browser);
      } finally {
        // Restore originals
        (Deno as any).Command = OriginalCommand;
        (globalThis as any).fetch = originalFetch;
        (globalThis as any).WebSocket = OriginalWebSocket;
      }
    },
  );

  await t.step(
    "close - gracefully closes when process.kill succeeds",
    async () => {
      let clientClosed = false;
      const fakeClient = {
        // deno-lint-ignore require-await
        sendCommand: async () => undefined,
        on: () => {},
        close: () => {
          clientClosed = true;
        },
      };

      const child = new FakeChildProcess("ok") as unknown as Deno.ChildProcess;
      const browser = {
        client: fakeClient,
        process: child,
        webSocketUrl: "ws://example",
      };

      await close(browser as any);

      assert(clientClosed, "client.close should be called");
      // @ts-ignore access to fake
      assertEquals(
        (child as any).killedWith,
        "SIGINT",
        "process should be killed with SIGINT",
      );
    },
  );

  await t.step(
    "close - ignores Deno.errors.NotFound from process.kill",
    async () => {
      let clientClosed = false;
      const fakeClient = {
        // deno-lint-ignore require-await
        sendCommand: async () => undefined,
        on: () => {},
        close: () => {
          clientClosed = true;
        },
      };

      const child = new FakeChildProcess(
        "notfound",
      ) as unknown as Deno.ChildProcess;
      const browser = {
        client: fakeClient,
        process: child,
        webSocketUrl: "ws://example",
      };

      await close(browser as any);

      assert(
        clientClosed,
        "client.close should still be called when process is already gone",
      );
    },
  );

  await t.step(
    "close - rethrows unexpected errors from process.kill",
    async () => {
      const fakeClient = {
        // deno-lint-ignore require-await
        sendCommand: async () => undefined,
        on: () => {},
        close: () => {},
      };

      const child = new FakeChildProcess(
        "other",
      ) as unknown as Deno.ChildProcess;
      const browser = {
        client: fakeClient,
        process: child,
        webSocketUrl: "ws://example",
      };

      await assertRejects(
        () => close(browser as any),
        Error,
        "unexpected kill error",
      );
    },
  );

  await t.step(
    "launch - throws when no browser executable is found",
    async () => {
      const OriginalCommand = Deno.Command;
      const originalFetch = globalThis.fetch;
      const OriginalWebSocket = globalThis.WebSocket;

      (Deno as any).Command = FakeCommand as unknown as typeof Deno.Command;
      (FakeCommand as any).versionCheckCode = 1;

      (globalThis as any).fetch = (() => {
        throw new Error("fetch should not be called when no browser is found");
      }) as typeof fetch;
      (globalThis as any).WebSocket =
        FakeWebSocket as unknown as typeof WebSocket;

      try {
        await assertRejects(
          () => launch(),
          Error,
          "Could not find a compatible browser installed on this system",
        );
      } finally {
        (Deno as any).Command = OriginalCommand;
        (globalThis as any).fetch = originalFetch;
        (globalThis as any).WebSocket = OriginalWebSocket;
        (FakeCommand as any).versionCheckCode = 0;
      }
    },
  );
});
