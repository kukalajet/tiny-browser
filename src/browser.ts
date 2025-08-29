import { delay } from "jsr:@std/async";

import { type CdpClient, createClient } from "./client.ts";

/**
 * Opaque type representing a running browser instance.
 * It holds the state needed for browser-level operations.
 */
interface Browser {
  readonly process: Deno.ChildProcess;
  readonly client: CdpClient;
  readonly webSocketUrl: string;
}

const findExecutablePathCandidates = () => {
  const os = Deno.build.os;

  if (os === "linux") {
    return [
      "google-chrome",
      "google-chrome-stable",
      "chromium-browser",
      "chromium",
    ];
  }

  if (os === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  }

  return [];
};

const checkPath = async (path: string) => {
  try {
    const command = new Deno.Command(path, { args: ["--version"] });
    const { code } = await command.output();
    return code === 0;
  } catch {
    return false;
  }
};

/**
 * Finds the path to the Chrome executable on the system.
 * @returns A promise that resolves to the path to the Chrome executable.
 */
const findChromeExecutable = async (): Promise<string> => {
  const candidates = findExecutablePathCandidates();
  for (const path of candidates) {
    if (await checkPath(path)) {
      return path;
    }
  }

  throw new Error(
    "Could not find a compatible browser installed on this system",
  );
};

/**
 * Retrieves the WebSocket URL for the browser's debugging endpoint.
 * @param port The port number to connect to.
 * @returns A promise that resolves to the WebSocket URL.
 */
const retrieveWebSocketUrl = async (port: number): Promise<string> => {
  for (let i = 0; i < 20; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const versionInfo = await response.json();
        return versionInfo.webSocketDebuggerUrl;
      }
    } catch {
      // Ignore connection errors and retry.
    }

    await delay(250);
  }

  throw new Error("Failed to connect to the browser's debugger endpoint.");
};

/**
 * Launches a new headless browser instance.
 * @returns A promise that resolves to a Browser instance.
 */
const launch = async (): Promise<Browser> => {
  const port = 9222; // Default port for Chrome DevTools Protocol debugging.
  const chromePath = await findChromeExecutable();

  const command = new Deno.Command(chromePath, {
    args: [
      "--headless",
      `--remote-debugging-port=${port}`,
      "--disable-gpu",
      "--no-sandbox",
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const process = command.spawn();

  const webSocketUrl = await retrieveWebSocketUrl(port);
  const client = await createClient(webSocketUrl);

  return { process, client, webSocketUrl };
};

/**
 * Closes the browser and terminates its process.
 * @param browser The Browser instance to close.
 */
const close = async (browser: Browser): Promise<void> => {
  browser.client.close();

  try {
    browser.process.kill("SIGINT");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  await browser.process.status;
};

export { close, launch };
