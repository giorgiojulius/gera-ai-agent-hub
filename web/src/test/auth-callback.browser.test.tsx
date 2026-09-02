import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider } from "@/hooks/use-auth";
import {
  AUTH_FLOW_ATTEMPT_KEY,
  AUTH_FLOW_NONCE_KEY,
  CODE_VERIFIER_KEY,
  authSessionSnapshot,
} from "@/lib/auth-tokens";
import { proxiedPopupName, trustedRelayOrigins } from "@/lib/proxied-popup";
import { TID } from "@/lib/testids";
import AuthCallback from "@/pages/AuthCallback";

type OpenerStub = { postMessage: ReturnType<typeof vi.fn> };

const originalName = window.name;

function mountLanding(search: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[`/auth/callback${search}`]}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/" element={<div data-testid="landing-home">home</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

/** Plays the window Gera opened for a sandboxed preview: a Gera-minted name and an opener to answer. */
function playProxiedPopup(): OpenerStub {
  const opener: OpenerStub = { postMessage: vi.fn() };
  window.name = proxiedPopupName();
  Object.defineProperty(window, "opener", { value: opener, configurable: true, writable: true });
  return opener;
}

function tokenEndpointCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes("/oauth/token")).length;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.name = originalName;
  try {
    delete (window as { opener?: unknown }).opener;
  } catch {
    // The accessor could not be restored; the next test redefines it anyway.
  }
});

test("in a window Gera opened for a preview, the landing hands the code to its opener — Gera origins only — and closes", async () => {
  const opener = playProxiedPopup();
  const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);
  const fetchMock = vi.fn(async (): Promise<Response> => new Response("{}", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);

  const screen = await mountLanding("?code=abc123&state=s");

  await expect.element(screen.getByTestId(TID.authCallbackStatus)).toHaveTextContent("Returning you to Gera");
  const expectedOrigins = trustedRelayOrigins(window.location.origin, import.meta.env.EXPO_PUBLIC_PROJECT_ID);
  expect(expectedOrigins.length).toBeGreaterThan(0);
  expect(opener.postMessage.mock.calls.map((call) => call[1])).toEqual(expectedOrigins);
  for (const call of opener.postMessage.mock.calls) {
    expect(call[0]).toEqual({ type: "rork_auth_callback", code: "abc123" });
    expect(call[1]).not.toBe("*");
  }
  await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 2_000 });
  // The verifier lives in the preview frame: this window never tries the exchange itself.
  expect(tokenEndpointCalls(fetchMock)).toBe(0);
  expect(screen.container.querySelector('[data-testid="landing-home"]')).toBeNull();
});

test("a refusal travels the same way so the preview stops waiting", async () => {
  const opener = playProxiedPopup();
  const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);

  await mountLanding("?error=access_denied&error_description=The+user+said+no");

  await vi.waitFor(() => expect(opener.postMessage).toHaveBeenCalled());
  expect(opener.postMessage.mock.calls[0]?.[0]).toEqual({ type: "rork_auth_callback", error: "The user said no" });
  // Let the self-close timer settle inside this test so it cannot leak into the next one.
  await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 2_000 });
});

test("the top-level landing still exchanges the code with this tab's own verifier", async () => {
  const nonce = authSessionSnapshot();
  sessionStorage.setItem(CODE_VERIFIER_KEY, "verifier-1");
  sessionStorage.setItem(AUTH_FLOW_NONCE_KEY, nonce);
  sessionStorage.setItem(AUTH_FLOW_ATTEMPT_KEY, "attempt-1");
  const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    if (String(input).includes("/oauth/token")) {
      return new Response(
        JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", user: { id: "u1", email: "u1@gera.app" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);

  const screen = await mountLanding("?code=abc123");

  await expect.element(screen.getByTestId("landing-home")).toBeVisible();
  expect(tokenEndpointCalls(fetchMock)).toBe(1);
  const tokenCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/oauth/token"));
  const tokenInit: RequestInit | undefined = tokenCall?.[1];
  expect(JSON.parse(String(tokenInit?.body))).toMatchObject({ code: "abc123", code_verifier: "verifier-1" });
  expect(closeSpy).not.toHaveBeenCalled();
});

test("a window with an opener but no verifier of its own relays too, and asks to be closed instead of failing", async () => {
  // An older Gera still opening plain `_blank` windows: opener present, no Gera-minted name, no verifier here.
  const opener: OpenerStub = { postMessage: vi.fn() };
  Object.defineProperty(window, "opener", { value: opener, configurable: true, writable: true });
  const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);
  const fetchMock = vi.fn(async (): Promise<Response> => new Response("{}", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);

  const screen = await mountLanding("?code=abc123");

  await expect.element(screen.getByTestId(TID.authCallbackStatus)).toHaveTextContent("you can close this window");
  expect(opener.postMessage).toHaveBeenCalledWith({ type: "rork_auth_callback", code: "abc123" }, window.location.origin);
  expect(tokenEndpointCalls(fetchMock)).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 900));
  expect(closeSpy).not.toHaveBeenCalled();
  expect(screen.container.querySelector('[data-testid="landing-home"]')).toBeNull();
});
