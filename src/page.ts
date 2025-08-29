import type { Browser } from "./browser.ts";
import type { CdpClient } from "./client.ts";

/**
 * Opaque type representing a single browser page (tab).
 * It holds the state needed for page-level operations.
 */
interface Page {
  readonly client: CdpClient;
  readonly targetId: string;
  readonly sessionId: string;
}

/**
 * Options for navigating to a URL.
 */
interface GoToOptions {
  /**
   * When to consider navigation succeeded, defaults to `load`.
   * - `load`: consider navigation to be finished when the load event is fired.
   * @note This option is temporarily unused.
   */
  waitUntil?: "load";

  /**
   * Maximum navigation time in milliseconds, defaults to 30 seconds, pass `0` to disable timeout.
   */
  timeout?: number;
}

/**
 * Options for capturing a screenshot of the page.
 */
interface ScreenshotOptions {
  /** The file path to save the screenshot to. */
  path: string;
  /** The format of the screenshot. */
  format?: "jpeg" | "png" | "webp";
  /** The compression quality from 0 to 100 (jpeg only). */
  quality?: number;
}

/**
 * Creates a new page (tab) in the browser.
 * @param browser The browser instance to create the page in.
 * @returns A promise that resolves to the newly created page.
 */
const newPage = async (browser: Browser): Promise<Page> => {
  const { targetId } = await browser.client.sendCommand<{ targetId: string }>(
    "Target.createTarget",
    { url: "about:blank" },
  );

  const { sessionId } = await browser.client.sendCommand<
    { sessionId: string }
  >("Target.attachToTarget", { targetId, flatten: true });

  // Enable page events for this session
  await browser.client.sendCommand("Page.enable", {}, sessionId);

  return { client: browser.client, targetId, sessionId };
};

/**
 * Navigates a page to a specified URL.
 * @param page The page to navigate.
 * @param url The URL to navigate to.
 * @param options Navigation options.
 * @returns A promise that resolves when the navigation is complete.
 */
const goto = async (
  page: Page,
  url: string,
  options: GoToOptions = {},
): Promise<void> => {
  const { timeout = 30000 } = options;

  const navigationPromise = new Promise<void>((resolve, reject) => {
    let timeoutId: number | undefined;

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        reject(new Error(`Navigation timeout of ${timeout} ms exceeded`));
      }, timeout);
    }

    const onPageLoad = () => {
      clearTimeout(timeoutId);
      resolve();
    };

    page.client.on("Page.loadEventFired", onPageLoad);
  });

  await page.client.sendCommand("Page.navigate", { url }, page.sessionId);
  await navigationPromise;
};

/**
 * Captures a screenshot of the page.
 * @param page The page to capture a screenshot of.
 * @param options Screenshot options.
 */
const screenshot = async (
  page: Page,
  options: ScreenshotOptions,
): Promise<void> => {
  const params = {
    format: options.format ?? "png",
    quality: options.quality,
  };

  const { data } = await page.client.sendCommand<{ data: string }>(
    "Page.captureScreenshot",
    params,
    page.sessionId,
  );

  const buffer = atob(data);
  const u8arr = new Uint8Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    u8arr[i] = buffer.charCodeAt(i);
  }

  await Deno.writeFile(options.path, u8arr);
};

/**
 * Closes a specific page (tab).
 * @param page The page to close.
 */
const closePage = async (page: Page): Promise<void> => {
  await page.client.sendCommand("Target.closeTarget", {
    targetId: page.targetId,
  });
};

export { closePage, goto, newPage, screenshot };
