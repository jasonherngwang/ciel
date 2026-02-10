import { createRouter, createRoute, createRootRoute } from "@tanstack/react-router";
import { Layout } from "./components/Layout";
import { SetupPage } from "./pages/SetupPage";
import { DashboardPage } from "./pages/DashboardPage";
import { AgentPage } from "./pages/AgentPage";

const rootRoute = createRootRoute({
  component: Layout,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: DashboardPage,
});

const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agent/$id",
  component: AgentPage,
});

const routeTree = rootRoute.addChildren([setupRoute, dashboardRoute, agentRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
