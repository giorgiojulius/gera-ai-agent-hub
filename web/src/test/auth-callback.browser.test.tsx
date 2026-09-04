import { useEffect } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AppRoutes } from "@/App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import {
  ACCESS_TOKEN_KEY,
  AUTH_FLOW_ATTEMPT_KEY,
  AUTH_FLOW_NONCE_KEY,
  CODE_VERIFIER_KEY,
  REFRESH_TOKEN_KEY,
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

function refreshEndpointCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes("/oauth/refresh")).length;
}

type Gate = { promise: Promise<Response>; open: (response: Response) => void };

/** A response the test releases by hand, so the order of two in-flight answers is under control. */
function gate(): Gate {
  let open: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const TOKENS_FOR_U1 = { access_token: "access-1", refresh_token: "refresh-1", user: { id: "u1", email: "u1@gera.app" } };

/** A JWT whose payload alone matters to the client: `exp` in the past makes boot try the refresh grant. */
function expiredAccessToken(): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode({ sub: "u0", email: "u0@gera.app", exp: 1 })}.sig`;
}

function armPkceAttempt(): void {
  sessionStorage.setItem(CODE_VERIFIER_KEY, "verifier-1");
  sessionStorage.setItem(AUTH_FLOW_NONCE_KEY, authSessionSnapshot());
  sessionStorage.setItem(AUTH_FLOW_ATTEMPT_KEY, "attempt-1");
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

test("in the real route tree the landing survives the identity flip mid-exchange and redeems the code exactly once", async () => {
  // Production regression: `/auth/callback` used to sit under the account
  // boundary, which re-keys the moment boot settles. The remounted landing
  // redeemed the same code again; Rork Auth answered the duplicate with
  // "Invalid or expired code", and when that answer landed first it cancelled
  // the sign-in that had just succeeded. Boot is held open here (a stale
  // refresh token) so the flip happens while the exchange is still out.
  armPkceAttempt();
  localStorage.setItem(ACCESS_TOKEN_KEY, expiredAccessToken());
  localStorage.setItem(REFRESH_TOKEN_KEY, "refresh-stale");
  const refreshGate = gate();
  const tokenGate = gate();
  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/oauth/refresh")) {
      return refreshGate.promise;
    }
    if (url.includes("/oauth/token")) {
      return tokenGate.promise;
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);

  const screen = await render(
    <TooltipProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={["/auth/callback?code=abc123"]}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>
    </TooltipProvider>,
  );

  await vi.waitFor(() => expect(tokenEndpointCalls(fetchMock)).toBe(1));
  await vi.waitFor(() => expect(refreshEndpointCalls(fetchMock)).toBe(1));
  const landing = screen.container.querySelector(`[data-testid="${TID.authCallbackStatus}"]`);
  expect(landing).not.toBeNull();

  // Boot settles: the stale grant is refused, identity moves "loading" → "signed-out".
  refreshGate.open(jsonResponse({ error: "invalid_grant" }, 401));
  await vi.waitFor(() => expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Same landing element, one token request, and the PKCE attempt it is completing is intact.
  expect(landing?.isConnected).toBe(true);
  expect(tokenEndpointCalls(fetchMock)).toBe(1);
  expect(sessionStorage.getItem(CODE_VERIFIER_KEY)).toBe("verifier-1");

  tokenGate.open(jsonResponse(TOKENS_FOR_U1, 200));
  await vi.waitFor(() => expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("access-1"));
  await expect
    .poll(() => screen.container.querySelector(`[data-testid="${TID.authCallbackStatus}"]`), { timeout: 3_000 })
    .toBeNull();
  expect(tokenEndpointCalls(fetchMock)).toBe(1);
});

test("two requests to redeem the same code while the first is still out share one token exchange", async () => {
  armPkceAttempt();
  const tokenGate = gate();
  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input).includes("/oauth/token")) {
      return tokenGate.promise;
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);

  let exchange: ((code: string) => Promise<void>) | null = null;
  function Probe() {
    const { exchangeCode, user, error } = useAuth();
    useEffect(() => {
      exchange = exchangeCode;
    }, [exchangeCode]);
    return (
      <div data-testid="probe">
        {user ? `user:${user.id}` : "anonymous"} {error ?? ""}
      </div>
    );
  }
  const screen = await render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await vi.waitFor(() => expect(exchange).not.toBeNull());

  const first = exchange!("abc123");
  const second = exchange!("abc123");
  expect(second).toBe(first);
  expect(tokenEndpointCalls(fetchMock)).toBe(1);

  tokenGate.open(jsonResponse(TOKENS_FOR_U1, 200));
  await Promise.all([first, second]);
  await expect.element(screen.getByTestId("probe")).toHaveTextContent("user:u1");
  expect(tokenEndpointCalls(fetchMock)).toBe(1);

  // Settled exchanges are forgotten: a later attempt with a fresh code is a new request.
  armPkceAttempt();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> =>
      String(input).includes("/oauth/token") ? jsonResponse({ error: "Invalid or expired code" }, 400) : jsonResponse({}, 404),
    ),
  );
  await exchange!("stale-code");
  await expect.element(screen.getByTestId("probe")).toHaveTextContent("rejected as invalid or expired");
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
