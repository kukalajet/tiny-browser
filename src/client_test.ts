import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
} from "jsr:@std/assert";
import { spy } from "jsr:@std/testing/mock";
import { createClient } from "./client.ts";

type AnyRecord = Record<string, unknown>;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onclose:
    | ((this: WebSocket, ev: CloseEvent | Event | unknown) => unknown)
    | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent<string>) => unknown) | null =
    null;

  sentMessages: string[] = [];
  sendCallCount = 0;
  closeCallCount = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  // Simulate open event
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.call(this as unknown as WebSocket, new Event("open"));
  }

  // Simulate server-initiated close
  failClose(ev: Event = new Event("close")) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.call(this as unknown as WebSocket, ev);
  }

  // Test helper to emit an incoming message
  receiveMessage(obj: unknown) {
    const data = typeof obj === "string"
      ? obj
      : JSON.stringify(obj, (_k, v) => v);
    this.onmessage?.call(
      this as unknown as WebSocket,
      { data } as MessageEvent<string>,
    );
  }

  send(data: string) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("WebSocket is not open (mock)");
    }
    this.sendCallCount++;
    this.sentMessages.push(data);
  }

  close() {
    this.closeCallCount++;
    this.readyState = MockWebSocket.CLOSED;
    // Do not auto-fire onclose here; caller controls when to emit close for tests
  }
}

function useMockWebSocket() {
  const OriginalWebSocket = globalThis.WebSocket;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).WebSocket = MockWebSocket as unknown as typeof WebSocket;

  return {
    MockWebSocket,
    restore() {
      // deno-lint-ignore no-explicit-any
      (globalThis as any).WebSocket = OriginalWebSocket;
      MockWebSocket.instances.splice(0, MockWebSocket.instances.length);
    },
  };
}

Deno.test("createClient", async (t) => {
  await t.step("should resolve once WebSocket opens", async () => {
    const { MockWebSocket, restore } = useMockWebSocket();
    try {
      const clientPromise = createClient("ws://devtools/test");
      // The instance is created synchronously when createClient is invoked
      const ws = MockWebSocket.instances.at(-1)!;
      assert(ws, "Mock WebSocket instance should be created");
      assertStrictEquals(ws.readyState, MockWebSocket.CONNECTING);

      ws.open();
      const client = await clientPromise;

      assert(client, "Client should be defined after open");
    } finally {
      restore();
    }
  });

  await t.step("should reject if WebSocket closes before opening", async () => {
    const { MockWebSocket, restore } = useMockWebSocket();
    try {
      const clientPromise = createClient("ws://devtools/close-early");
      const ws = MockWebSocket.instances.at(-1)!;
      ws.failClose(new Event("close"));

      await assertRejects(async () => await clientPromise);
    } finally {
      restore();
    }
  });

  await t.step("sendCommand - happy path resolves with result", async () => {
    const { MockWebSocket, restore } = useMockWebSocket();
    try {
      const clientPromise = createClient("ws://devtools/happy");
      const ws = MockWebSocket.instances.at(-1)!;
      ws.open();
      const client = await clientPromise;

      const command = client.sendCommand<{ ok: boolean }>(
        "Browser.getVersion",
        { verbose: true },
      );

      // Inspect the last sent message
      assertEquals(ws.sendCallCount, 1);
      const sent = JSON.parse(ws.sentMessages[0]) as AnyRecord;
      assertStrictEquals(typeof sent.id, "number");
      assertEquals(sent.method, "Browser.getVersion");
      assertEquals(sent.params, { verbose: true });
      assertEquals(Object.hasOwn(sent, "sessionId"), false);

      // Simulate CDP responding with the same id
      ws.receiveMessage({ id: sent.id, result: { ok: true } });

      const result = await command;
      assertEquals(result, { ok: true });
    } finally {
      restore();
    }
  });

  await t.step("sendCommand - includes sessionId when provided", async () => {
    const { MockWebSocket, restore } = useMockWebSocket();
    try {
      const clientPromise = createClient("ws://devtools/session");
      const ws = MockWebSocket.instances.at(-1)!;
      ws.open();
      const client = await clientPromise;

      const p = client.sendCommand(
        "Target.attachToTarget",
        {
          targetId: "t1",
        },
        "session-123",
      );

      const sent = JSON.parse(ws.sentMessages.at(-1)!) as AnyRecord;
      assertEquals(sent.sessionId, "session-123");
      ws.receiveMessage({ id: sent.id, result: { attached: true } });

      const res = await p;
      assertEquals(res, { attached: true });
    } finally {
      restore();
    }
  });

  await t.step("sendCommand - defaults params to empty object", async () => {
    const { MockWebSocket, restore } = useMockWebSocket();
    try {
      const clientPromise = createClient("ws://devtools/default-params");
      const ws = MockWebSocket.instances.at(-1)!;
      ws.open();
      const client = await clientPromise;

      const p = client.sendCommand("Page.enable");
      const sent = JSON.parse(ws.sentMessages.at(-1)!) as AnyRecord;
      assertEquals(sent.params, {});

      ws.receiveMessage({ id: sent.id, result: {} });
      await p;
    } finally {
      restore();
    }
  });

  await t.step(
    "sendCommand - rejects when response contains error",
    async () => {
      const { MockWebSocket, restore } = useMockWebSocket();
      try {
        const clientPromise = createClient("ws://devtools/error");
        const ws = MockWebSocket.instances.at(-1)!;
        ws.open();
        const client = await clientPromise;

        const p = client.sendCommand("Runtime.evaluate", {
          expression: "bad()",
        });

        const sent = JSON.parse(ws.sentMessages.at(-1)!) as AnyRecord;
        ws.receiveMessage({
          id: sent.id,
          error: { code: -32000, message: "Evaluation failed" },
        });

        await assertRejects(async () => await p);
      } finally {
        restore();
      }
    },
  );

  await t.step(
    "sendCommand - rejects immediately if socket is not open",
    async () => {
      const { MockWebSocket, restore } = useMockWebSocket();
      try {
        const clientPromise = createClient("ws://devtools/not-open");
        const ws = MockWebSocket.instances.at(-1)!;
        ws.open();
        const client = await clientPromise;

        // Transition to CLOSED to simulate non-open state
        ws.close();
        assertNotEquals(ws.readyState, MockWebSocket.OPEN);

        await assertRejects(
          async () => {
            await client.sendCommand("Page.navigate", { url: "about:blank" });
          },
          Error,
          "WebSocket is not open",
        );
      } finally {
        restore();
      }
    },
  );

  await t.step(
    "events - invokes all listeners for a method in registration order",
    async () => {
      const { MockWebSocket, restore } = useMockWebSocket();
      try {
        const clientPromise = createClient("ws://devtools/events");
        const ws = MockWebSocket.instances.at(-1)!;
        ws.open();
        const client = await clientPromise;

        const calls: AnyRecord[] = [];
        client.on("Network.requestWillBeSent", (p) => calls.push({ a: p }));
        client.on("Network.requestWillBeSent", (p) => calls.push({ b: p }));

        const eventPayload = { url: "https://example.test/", requestId: "1" };
        ws.receiveMessage({
          method: "Network.requestWillBeSent",
          params: eventPayload,
        });

        assertEquals(calls.length, 2);
        assertEquals(calls[0], { a: eventPayload });
        assertEquals(calls[1], { b: eventPayload });
      } finally {
        restore();
      }
    },
  );

  await t.step(
    "events - adding the same callback twice results in single invocation (Set semantics)",
    async () => {
      const { MockWebSocket, restore } = useMockWebSocket();
      try {
        const clientPromise = createClient("ws://devtools/event-dup");
        const ws = MockWebSocket.instances.at(-1)!;
        ws.open();
        const client = await clientPromise;

        let count = 0;
        const cb = () => {
          count++;
        };

        client.on("Debugger.scriptParsed", cb);
        client.on("Debugger.scriptParsed", cb); // duplicate registration

        ws.receiveMessage({
          method: "Debugger.scriptParsed",
          params: { scriptId: "1" },
        });

        assertEquals(count, 1);
      } finally {
        restore();
      }
    },
  );

  await t.step(
    "events - handles event with empty params and no listeners gracefully",
    async () => {
      const { MockWebSocket, restore } = useMockWebSocket();
      try {
        const clientPromise = createClient("ws://devtools/empty-event");
        const ws = MockWebSocket.instances.at(-1)!;
        ws.open();
        await clientPromise;

        // No listeners registered for this event; should not throw
        ws.receiveMessage({ method: "Log.entryAdded", params: {} });
        assert(true);
      } finally {
        restore();
      }
    },
  );

  await t.step(
    "events - if message has id with no pending command but has method, still dispatches event",
    async () => {
      const { MockWebSocket, restore } = useMockWebSocket();
      try {
        const clientPromise = createClient("ws://devtools/event-with-id");
        const ws = MockWebSocket.instances.at(-1)!;
        ws.open();
        const client = await clientPromise;

        let received: AnyRecord | null = null;
        client.on("Runtime.consoleAPICalled", (p) => {
          received = p;
        });

        // Send a message with id that doesn't map to pendingCommands and also has method
        ws.receiveMessage({
          id: 99999,
          method: "Runtime.consoleAPICalled",
          params: { type: "log", args: ["x"] },
        });

        assertEquals(received, { type: "log", args: ["x"] });
      } finally {
        restore();
      }
    },
  );

  await t.step(
    "close - should call ws.close only when socket is open (spy verified)",
    async () => {
      const { MockWebSocket, restore } = useMockWebSocket();
      try {
        const clientPromise = createClient("ws://devtools/close");
        const ws = MockWebSocket.instances.at(-1)!;
        ws.open();
        const client = await clientPromise;

        const s = spy(ws as unknown as Record<string, unknown>, "close");

        client.close();
        assertEquals(s.calls.length, 1);

        ws.readyState = MockWebSocket.CLOSING; // simulate not OPEN
        client.close();
        assertEquals(s.calls.length, 1); // unchanged

        s.restore();
      } finally {
        restore();
      }
    },
  );

  await t.step(
    "sendCommand - supports multiple concurrent commands resolved out of order",
    async () => {
      const { MockWebSocket, restore } = useMockWebSocket();
      try {
        const clientPromise = createClient("ws://devtools/concurrent");
        const ws = MockWebSocket.instances.at(-1)!;
        ws.open();
        const client = await clientPromise;

        const p1 = client.sendCommand("Page.getResourceTree");
        const sent1 = JSON.parse(ws.sentMessages.at(-1)!) as AnyRecord;

        const p2 = client.sendCommand("Page.getFrameTree");
        const sent2 = JSON.parse(ws.sentMessages.at(-1)!) as AnyRecord;

        // Resolve p2 first, then p1
        ws.receiveMessage({ id: sent2.id, result: { name: "frameTree" } });
        ws.receiveMessage({ id: sent1.id, result: { name: "resourceTree" } });

        const [r1, r2] = await Promise.all([p1, p2]);
        assertEquals(r1, { name: "resourceTree" });
        assertEquals(r2, { name: "frameTree" });
      } finally {
        restore();
      }
    },
  );
});
