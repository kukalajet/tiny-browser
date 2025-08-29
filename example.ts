import { Browser, Page } from "./src/mod.ts";

console.log("🚀 Starting Tiny Browser");
const browser = await Browser.launch();
console.log("✅ Browser launched successfully");

try {
  const page = await Page.create(browser);
  console.log("📄 New page created successfully");

  console.log("🚢 Navigating to `https://deno.land/`...");
  await Page.goto(page, "https://deno.land/");
  console.log("✅ Navigation completed successfully");

  const screenshotPath = "deno_land.png";
  await Page.screenshot(page, { path: screenshotPath });
  console.log(`📸 Screenshot saved successfully to ${screenshotPath}`);
} catch (error) {
  console.error("An error occurred during automation:", error);
} finally {
  await Browser.close(browser);
  console.log("✅ Browser closed successfully");
  console.log("✨ Automation completed successfully");
}
