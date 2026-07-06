import { HonuaClient } from "@honua/sdk-js/honua";
import { HonuaAuthError } from "@honua/sdk-js";
import { oauth2 } from "@honua/sdk-js/auth";

declare global {
  interface Window {
    __HONUA_OAUTH_SIGNIN_DEMO__?: {
      ready: boolean;
      status: string;
      signedIn: boolean;
      whoami?: unknown;
    };
  }
}

const origin = window.location.origin;

// The mock IdP (mock-server.mjs) hosts the authorize + token endpoints on the
// same origin as the example, so the whole redirect round-trip is self-hosted.
const auth = oauth2({
  authorizationEndpoint: `${origin}/oauth/authorize`,
  tokenEndpoint: `${origin}/oauth/token`,
  clientId: "honua-oauth-demo",
  redirectUri: `${origin}/`,
  scopes: ["openid", "profile", "honua.read"],
});

const client = new HonuaClient({ baseUrl: origin, auth });

const statusEl = document.querySelector<HTMLElement>("#status");
const outputEl = document.querySelector<HTMLElement>("#output");
const signInButton = document.querySelector<HTMLButtonElement>("#signin");
const signOutButton = document.querySelector<HTMLButtonElement>("#signout");

function publish(status: string, signedIn: boolean, whoami?: unknown): void {
  if (statusEl) statusEl.textContent = status;
  window.__HONUA_OAUTH_SIGNIN_DEMO__ = {
    ready: true,
    status,
    signedIn,
    whoami,
  };
}

async function loadProtectedResource(): Promise<void> {
  // The token is attached transparently by the client's auth provider.
  const whoami = await client.request({ path: "/api/v1/whoami" });
  if (outputEl) outputEl.textContent = JSON.stringify(whoami, null, 2);
  if (signInButton) signInButton.hidden = true;
  if (signOutButton) signOutButton.hidden = false;
  publish("signed-in", true, whoami);
}

signInButton?.addEventListener("click", () => {
  publish("redirecting", false);
  void auth.signIn();
});

signOutButton?.addEventListener("click", async () => {
  await auth.signOut();
  if (outputEl) outputEl.textContent = "";
  if (signOutButton) signOutButton.hidden = true;
  if (signInButton) signInButton.hidden = false;
  publish("signed-out", false);
});

async function bootstrap(): Promise<void> {
  try {
    if (auth.isRedirectCallback()) {
      publish("completing-sign-in", false);
      await auth.handleRedirectCallback();
      // Clean the code/state out of the address bar.
      window.history.replaceState({}, document.title, window.location.pathname);
      await loadProtectedResource();
      return;
    }
    if (await auth.isSignedIn()) {
      await loadProtectedResource();
      return;
    }
    if (signInButton) signInButton.hidden = false;
    publish("signed-out", false);
  } catch (error) {
    const message =
      error instanceof HonuaAuthError ? `${error.code}: ${error.message}` : String(error);
    if (outputEl) outputEl.textContent = message;
    if (signInButton) signInButton.hidden = false;
    publish("error", false);
  }
}

void bootstrap();
