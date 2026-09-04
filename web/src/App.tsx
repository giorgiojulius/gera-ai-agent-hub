import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, type ReactNode } from "react";
import { BrowserRouter, Navigate, Routes, Route, useNavigate } from "react-router-dom";

import { AccessGate } from "@/components/gera/AccessGate";
import { registerNavigate } from "@/lib/nav";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentProvider } from "@/hooks/use-agent";
import { AuthProvider, useAuth } from "@/hooks/use-auth";

import AdminPage from "./pages/Admin";
import AuthCallback from "./pages/AuthCallback";
import AutomationsPage from "./pages/Automations";
import HubPage from "./pages/Hub";
import Index from "./pages/Index";
import McpPage from "./pages/Mcp";
import NotFound from "./pages/NotFound";
import OAuthCallback from "./pages/OAuthCallback";
import ProfilesPage from "./pages/Profiles";
import ProjectSpacePage from "./pages/ProjectSpace";
import ProjectsPage from "./pages/Projects";
import ScreenDeskPage from "./pages/ScreenDesk";
import SettingsPage from "./pages/Settings";
import SkillsPage from "./pages/Skills";
import SharedChat from "./pages/SharedChat";

/** Hands react-router's navigate to non-router code (toast actions, notifications). */
const NavBridge = () => {
  const navigate = useNavigate();
  useEffect(() => registerNavigate((to: string) => navigate(to)), [navigate]);
  return null;
};

/** Remounts state and creates a fresh query cache when authentication identity changes. */
const AccountProviders = ({ children }: { children: ReactNode }) => {
  const { user, isLoading } = useAuth();
  const identity = isLoading ? "loading" : user?.id ?? "signed-out";
  const queryClient = useMemo(() => new QueryClient(), [identity]);
  return (
    <QueryClientProvider client={queryClient}>
      <AgentProvider key={identity}>{children}</AgentProvider>
    </QueryClientProvider>
  );
};

/** Everything that belongs to one signed-in account — remounted by `AccountProviders` when the identity changes. */
const AccountRoutes = () => (
  <Routes>
    <Route
      path="/"
      element={
        <AccessGate>
          <Index />
        </AccessGate>
      }
    />
    {/* Every chat thread has its own address. */}
    <Route
      path="/c/:chatId"
      element={
        <AccessGate>
          <Index />
        </AccessGate>
      }
    />
    <Route
      path="/profiles"
      element={
        <AccessGate>
          <ProfilesPage />
        </AccessGate>
      }
    />
    {/* Profile editor — /profiles/new or /profiles/<id>. */}
    <Route
      path="/profiles/:profileId"
      element={
        <AccessGate>
          <ProfilesPage />
        </AccessGate>
      }
    />
    {/* The old name still works — old links land on Profiles. */}
    <Route path="/agents" element={<Navigate to="/profiles" replace />} />
    <Route
      path="/skills"
      element={
        <AccessGate>
          <SkillsPage />
        </AccessGate>
      }
    />
    <Route
      path="/skills/:skillId"
      element={
        <AccessGate>
          <SkillsPage />
        </AccessGate>
      }
    />
    <Route
      path="/automations"
      element={
        <AccessGate>
          <AutomationsPage />
        </AccessGate>
      }
    />
    <Route
      path="/automations/:automationId"
      element={
        <AccessGate>
          <AutomationsPage />
        </AccessGate>
      }
    />
    <Route
      path="/projects"
      element={
        <AccessGate>
          <ProjectsPage />
        </AccessGate>
      }
    />
    <Route
      path="/projects/:projectId"
      element={
        <AccessGate>
          <ProjectSpacePage />
        </AccessGate>
      }
    />
    <Route
      path="/projects/:projectId/screens/:screenId"
      element={
        <AccessGate>
          <ScreenDeskPage />
        </AccessGate>
      }
    />
    {/* One channel's address inside a project. */}
    <Route
      path="/projects/:projectId/channels/:channelId"
      element={
        <AccessGate>
          <ProjectSpacePage />
        </AccessGate>
      }
    />
    {/* Workspace tabs: /projects/<id>/agents|screens|members. */}
    <Route
      path="/projects/:projectId/:tab"
      element={
        <AccessGate>
          <ProjectSpacePage />
        </AccessGate>
      }
    />
    <Route
      path="/hub"
      element={
        <AccessGate>
          <HubPage />
        </AccessGate>
      }
    />
    <Route
      path="/mcp"
      element={
        <AccessGate>
          <McpPage />
        </AccessGate>
      }
    />
    <Route
      path="/settings"
      element={
        <AccessGate>
          <SettingsPage />
        </AccessGate>
      }
    />
    {/* The arena now lives inside the admin panel — old links follow. */}
    <Route path="/arena" element={<Navigate to="/admin?tab=arena" replace />} />
    <Route
      path="/admin"
      element={
        <AccessGate>
          <AdminPage />
        </AccessGate>
      }
    />
    {/* Public on purpose — share links must open without an account. */}
    <Route path="/s/:shareId" element={<SharedChat />} />
    <Route path="*" element={<NotFound />} />
  </Routes>
);

/**
 * The route tree, for a router provided above it.
 *
 * The sign-in landings live outside the account boundary on purpose.
 * `AccountProviders` re-keys everything under it whenever the identity moves
 * ("loading" → "signed-out" → the account) — exactly what a landing causes.
 * Inside that boundary `/auth/callback` was torn down and mounted afresh
 * mid-exchange, redeemed its one-time code a second time, and the "Invalid or
 * expired code" answer to that duplicate cancelled the sign-in that had just
 * succeeded. Out here the landing keeps its state until it navigates away.
 */
export const AppRoutes = () => (
  <Routes>
    <Route path="/auth/callback" element={<AuthCallback />} />
    <Route path="/oauth/callback" element={<OAuthCallback />} />
    <Route
      path="/*"
      element={
        <AccountProviders>
          <Toaster />
          <AccountRoutes />
        </AccountProviders>
      }
    />
  </Routes>
);

const App = () => (
  <TooltipProvider>
    <AuthProvider>
      {/* Vite's --base makes the router follow when the build is hosted below a path (Repo Preview); "/" in production. */}
      <BrowserRouter basename={import.meta.env.BASE_URL} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <NavBridge />
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  </TooltipProvider>
);

export default App;
