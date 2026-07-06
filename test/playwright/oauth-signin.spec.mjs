import { expect, test } from "@playwright/test";
import { startOAuthSignInFixtureServer } from "../../examples/oauth-signin/mock-server.mjs";

test.setTimeout(90_000);

test("OAuth2 + PKCE redirect flow signs in and loads a protected resource", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startOAuthSignInFixtureServer();
  try {
    await page.goto(server.url);

    // App boots signed-out and offers a sign-in button.
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_OAUTH_SIGNIN_DEMO__?.status))
      .toBe("signed-out");
    await expect(page.locator("#signin")).toBeVisible();

    // Clicking sign-in redirects to the mock IdP authorize endpoint, which
    // auto-consents and redirects back with ?code&state; the app then exchanges
    // the code (with the PKCE verifier) and calls the protected resource.
    await page.locator("#signin").click();

    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_OAUTH_SIGNIN_DEMO__?.signedIn), { timeout: 30_000 })
      .toBe(true);
    await expect(page.locator("#output")).toContainText("demo-user");
    // The address bar was cleaned of the ?code&state params.
    await expect.poll(async () => new URL(page.url()).searchParams.has("code")).toBe(false);

    // Sign-out clears the session and returns to the signed-out state.
    await page.locator("#signout").click();
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_OAUTH_SIGNIN_DEMO__?.signedIn))
      .toBe(false);

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
