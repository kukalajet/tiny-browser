/**
 * Represents the low-level client for communicating over the Chrome DevTools Protocol.
 */
interface CdpClient {
  /**
   * Sends a command and returns a promise that resolves with the result.
   */
  sendCommand: <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<T>;

  /**
   * Subscribes to a CDP event.
   */
  on: (
    event: string,
    callback: (params: Record<string, unknown>) => void,
  ) => void;

  /**
   * Closes the WebSocket connection.
   */
  close: () => void;
}

/**
 * Creates a low-level client to communicate with the browser over the Chrome DevTools Protocol.
 * @param webSocketUrl The URL of the WebSocket endpoint to connect to.
 * @returns A `CdpClient` instance.
 */
const createClient = async (webSocketUrl: string): Promise<CdpClient> => {
  const ws = new WebSocket(webSocketUrl);
  const {
    promise: connectionPromise,
    resolve: resolveConnection,
    reject: rejectConnection,
  } = Promise.withResolvers<void>();

  let messageId = 0;
  const eventListeners = new Map<
    string,
    Set<(params: Record<string, unknown>) => void>
  >();
  const pendingCommands = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
  >();

  ws.onopen = () => resolveConnection();
  ws.onclose = (e) => rejectConnection(e);

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.id) {
      const hasPendingCommand = pendingCommands.has(data.id);
      if (hasPendingCommand) {
        const { resolve, reject } = pendingCommands.get(data.id)!;
        pendingCommands.delete(data.id);

        if (data.error) {
          reject(data.error);
        } else {
          resolve(data.result);
        }

        return;
      }
    }

    if (data.method) {
      const listeners = eventListeners.get(data.method);
      listeners?.forEach((callback) => callback(data.params));
    }
  };

  const client: CdpClient = {
    sendCommand: <T>(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ): Promise<T> => {
      if (ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("WebSocket is not open"));
      }

      const id = ++messageId;
      const promise = new Promise<T>((resolve, reject) => {
        pendingCommands.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });

      const message = sessionId
        ? { id, method, params, sessionId }
        : { id, method, params };

      ws.send(JSON.stringify(message));

      return promise;
    },

    on: (
      event: string,
      callback: (params: Record<string, unknown>) => void,
    ) => {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, new Set());
      }

      eventListeners.get(event)!.add(callback);
    },

    close: () => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }

      ws.close();
    },
  };

  await connectionPromise;
  return client;
};

export { type CdpClient, createClient };
