import { close, goto, launch, newPage, screenshot } from "./src/mod.ts";

console.log("🚀 Starting Tiny Browser");
const browser = await launch();
console.log("✅ Browser launched successfully");

try {
  const page = await newPage(browser);
  console.log("📄 New page created successfully");

  console.log("🚢 Navigating to `https://deno.land/`...");
  await goto(page, "https://deno.land/");
  console.log("✅ Navigation completed successfully");

  const screenshotPath = "deno_land.png";
  await screenshot(page, { path: screenshotPath });
  console.log(`📸 Screenshot saved successfully to ${screenshotPath}`);
} catch (error) {
  console.error("An error occurred during automation:", error);
} finally {
  await close(browser);
  console.log("✅ Browser closed successfully");
  console.log("✨ Automation completed successfully");
}
