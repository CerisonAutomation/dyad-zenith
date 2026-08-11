import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./router";
import { RouterProvider } from "@tanstack/react-router";
import log from "electron-log";

// Initialize i18next before any rendering
import "./i18n";
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  MutationCache,
  useQueryClient,
} from "@tanstack/react-query";
import { showError } from "./lib/toast";
import { ipc } from "./ipc/types";
import { useStore } from "jotai";
import { queryKeys } from "./lib/queryKeys";
import { registerRendererIpcListeners } from "./app_wiring/registerRendererIpcListeners";
import {
  ChatStreamProvider,
  useChatStreamManager,
} from "./chat_stream/ChatStreamProvider";
import {
  EntityDisposalProvider,
  useEntityDisposal,
  useRegisterEntityDisposer,
} from "./state_machines/react";
import { clearTestRuntimeForAppAtom } from "./atoms/testRuntimeAtoms";
import {
  ensureRecentViewedChatIdAtom,
  initializeChatTabSessionStorageAtom,
} from "./atoms/chatAtoms";
import {
  configureChatTabWindowSession,
  promoteMostRecentChatTabSession,
  pruneChatTabWindowSessions,
} from "./window_infrastructure/chat_tab_session_storage";
import type { VisibleEntity } from "./window_infrastructure/types";
import { initialWindowNavigation } from "./window_infrastructure/initial_window_navigation";
import { registerEarlyRendererEvents } from "./app_wiring/early_renderer_events";

const logger = log.scope("renderer");

registerEarlyRendererEvents();

interface MyMeta extends Record<string, unknown> {
  showErrorToast: boolean;
}

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: MyMeta;
    mutationMeta: MyMeta;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (query.meta?.showErrorToast) {
        showError(error);
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.showErrorToast) {
        showError(error);
      }
    },
  }),
});

function App() {
  return (
    <ChatStreamProvider>
      <RendererServices />
    </ChatStreamProvider>
  );
}

function RendererServices() {
  const queryClient = useQueryClient();
  const store = useStore();
  const chatStreamManager = useChatStreamManager();
  const entityDisposal = useEntityDisposal();
  const [windowReady, setWindowReady] = useState(false);
  const clearAppRuntime = useCallback(
    (appId: number) => {
      store.set(clearTestRuntimeForAppAtom, appId);
    },
    [store],
  );
  useRegisterEntityDisposer("app", clearAppRuntime);

  // Fetch user budget on app load
  useEffect(() => {
    queryClient.prefetchQuery({
      queryKey: queryKeys.userBudget.info,
      queryFn: () => ipc.system.getUserBudget(),
    });
  }, [queryClient]);

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelayMs = 100;
    const bootstrapWindow = () => {
      void ipc.windowInfrastructure
        .bootstrap({})
        .then((bootstrap) => {
          if (disposed) return;
          configureChatTabWindowSession(bootstrap.windowSessionId, {
            mayMigrateLegacySession: bootstrap.mayMigrateLegacyChatTabSession,
          });
          try {
            if (bootstrap.mayMigrateLegacyChatTabSession) {
              promoteMostRecentChatTabSession(
                window.localStorage,
                bootstrap.windowSessionId,
              );
            }
            pruneChatTabWindowSessions(
              window.localStorage,
              bootstrap.restorableWindowSessionIds,
            );
            store.set(initializeChatTabSessionStorageAtom);
          } catch (error) {
            // Browser storage is optional presentation state. A denied or full
            // localStorage must not turn a successful main-process bootstrap
            // into a permanently blank product window.
            logger.error(
              "Failed to initialize chat tab session storage",
              error,
            );
          }
          const entity: VisibleEntity | undefined = bootstrap.initialEntity;
          if (entity?.kind === "chat") {
            // Seed the tab before route navigation. ChatTabs hydration merges
            // pre-hydration opens, so this works even with a collapsed sidebar.
            store.set(ensureRecentViewedChatIdAtom, entity.id);
          }
          const navigation = initialWindowNavigation(
            entity,
            bootstrap.initialChatAppId,
          );
          if (navigation) {
            void router.navigate({ ...navigation, replace: true });
          }
          setWindowReady(true);
        })
        .catch((error) => {
          if (disposed) return;
          logger.error("Failed to initialize window session", error);
          retryTimer = setTimeout(bootstrapWindow, retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
        });
    };
    bootstrapWindow();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    if (!windowReady) return;
    return registerRendererIpcListeners({
      ipcClient: ipc,
      store,
      queryClient,
      chatStreamManager,
      entityDisposal,
      getCurrentPathname: () => router.state.location.pathname,
      subscribeToNavigation: (listener) =>
        router.subscribe("onResolved", listener),
    });
  }, [chatStreamManager, entityDisposal, queryClient, store, windowReady]);

  return windowReady ? (
    <RouterProvider router={router} />
  ) : (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        fontFamily: "system-ui, sans-serif",
        fontSize: "14px",
        color: "#888",
        background: "#0d0d0d",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: "32px", marginBottom: "12px" }}>⚡</div>
        <div>Starting Dyad...</div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <EntityDisposalProvider>
        <App />
      </EntityDisposalProvider>
    </QueryClientProvider>
  </StrictMode>,
);
