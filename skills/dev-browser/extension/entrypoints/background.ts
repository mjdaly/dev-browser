/**
 * dev-browser Chrome Extension Background Script
 *
 * This extension connects to the dev-browser relay server and allows
 * Playwright automation of the user's existing browser tabs.
 */

import type {
  TabInfo,
  ExtensionCommandMessage,
  ExtensionResponseMessage,
  TargetInfo,
} from "../utils/types";

const RELAY_URL = "ws://localhost:9222/extension";

// State
const tabs = new Map<number, TabInfo>();
const childSessions = new Map<string, number>(); // sessionId -> parentTabId
let ws: WebSocket | null = null;
let nextSessionId = 1;

export default defineBackground(() => {
  // ============================================================================
  // Logging
  // ============================================================================

  function sendLog(level: string, args: unknown[]) {
    sendMessage({
      method: "log",
      params: {
        level,
        args: args.map((arg) => {
          if (arg === undefined) return "undefined";
          if (arg === null) return "null";
          if (typeof arg === "object") {
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          }
          return String(arg);
        }),
      },
    });
  }

  const logger = {
    log: (...args: unknown[]) => {
      console.log("[dev-browser]", ...args);
      sendLog("log", args);
    },
    debug: (...args: unknown[]) => {
      console.debug("[dev-browser]", ...args);
      sendLog("debug", args);
    },
    error: (...args: unknown[]) => {
      console.error("[dev-browser]", ...args);
      sendLog("error", args);
    },
  };

  // ============================================================================
  // WebSocket Communication
  // ============================================================================

  function sendMessage(message: unknown): void {
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        console.debug("Error sending message:", error);
      }
    }
  }

  // ============================================================================
  // Tab/Session Helpers
  // ============================================================================

  function getTabBySessionId(sessionId: string): { tabId: number; tab: TabInfo } | undefined {
    for (const [tabId, tab] of tabs) {
      if (tab.sessionId === sessionId) {
        return { tabId, tab };
      }
    }
    return undefined;
  }

  function getTabByTargetId(targetId: string): { tabId: number; tab: TabInfo } | undefined {
    for (const [tabId, tab] of tabs) {
      if (tab.targetId === targetId) {
        return { tabId, tab };
      }
    }
    return undefined;
  }

  // ============================================================================
  // CDP Command Handling
  // ============================================================================

  async function handleCommand(msg: ExtensionCommandMessage): Promise<unknown> {
    if (msg.method !== "forwardCDPCommand") return;

    let targetTabId: number | undefined;
    let targetTab: TabInfo | undefined;

    // Find target tab by sessionId
    if (msg.params.sessionId) {
      const found = getTabBySessionId(msg.params.sessionId);
      if (found) {
        targetTabId = found.tabId;
        targetTab = found.tab;
      }
    }

    // Check child sessions (iframes, workers)
    if (!targetTab && msg.params.sessionId) {
      const parentTabId = childSessions.get(msg.params.sessionId);
      if (parentTabId) {
        targetTabId = parentTabId;
        targetTab = tabs.get(parentTabId);
        logger.debug(
          "Found parent tab for child session:",
          msg.params.sessionId,
          "tabId:",
          parentTabId
        );
      }
    }

    // Find by targetId in params
    if (
      !targetTab &&
      msg.params.params &&
      typeof msg.params.params === "object" &&
      "targetId" in msg.params.params
    ) {
      const found = getTabByTargetId(msg.params.params.targetId as string);
      if (found) {
        targetTabId = found.tabId;
        targetTab = found.tab;
      }
    }

    const debuggee = targetTabId ? { tabId: targetTabId } : undefined;

    // Handle special commands
    switch (msg.params.method) {
      case "Runtime.enable": {
        if (!debuggee) {
          throw new Error(
            `No debuggee found for Runtime.enable (sessionId: ${msg.params.sessionId})`
          );
        }
        // Disable and re-enable to reset state
        try {
          await chrome.debugger.sendCommand(debuggee, "Runtime.disable");
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch {
          // Ignore errors
        }
        return await chrome.debugger.sendCommand(debuggee, "Runtime.enable", msg.params.params);
      }

      case "Target.createTarget": {
        const url = (msg.params.params?.url as string) || "about:blank";
        logger.debug("Creating new tab with URL:", url);
        const tab = await chrome.tabs.create({ url, active: false });
        if (!tab.id) throw new Error("Failed to create tab");
        await new Promise((resolve) => setTimeout(resolve, 100));
        const targetInfo = await attachTab(tab.id);
        return { targetId: targetInfo.targetId };
      }

      case "Target.closeTarget": {
        if (!targetTabId) {
          logger.log(`Target not found: ${msg.params.params?.targetId}`);
          return { success: false };
        }
        await chrome.tabs.remove(targetTabId);
        return { success: true };
      }
    }

    if (!debuggee || !targetTab) {
      throw new Error(
        `No tab found for method ${msg.params.method} sessionId: ${msg.params.sessionId}`
      );
    }

    logger.debug("CDP command:", msg.params.method, "for tab:", targetTabId);

    const debuggerSession: chrome.debugger.DebuggerSession = {
      ...debuggee,
      sessionId: msg.params.sessionId !== targetTab.sessionId ? msg.params.sessionId : undefined,
    };

    return await chrome.debugger.sendCommand(debuggerSession, msg.params.method, msg.params.params);
  }

  // ============================================================================
  // Chrome Debugger Events
  // ============================================================================

  function onDebuggerEvent(
    source: chrome.debugger.DebuggerSession,
    method: string,
    params: unknown
  ): void {
    const tab = source.tabId ? tabs.get(source.tabId) : undefined;
    if (!tab) return;

    logger.debug("Forwarding CDP event:", method, "from tab:", source.tabId);

    // Track child sessions
    if (
      method === "Target.attachedToTarget" &&
      params &&
      typeof params === "object" &&
      "sessionId" in params
    ) {
      const sessionId = (params as { sessionId: string }).sessionId;
      logger.debug("Child target attached:", sessionId, "for tab:", source.tabId);
      childSessions.set(sessionId, source.tabId!);
    }

    if (
      method === "Target.detachedFromTarget" &&
      params &&
      typeof params === "object" &&
      "sessionId" in params
    ) {
      const sessionId = (params as { sessionId: string }).sessionId;
      logger.debug("Child target detached:", sessionId);
      childSessions.delete(sessionId);
    }

    sendMessage({
      method: "forwardCDPEvent",
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    });
  }

  function onDebuggerDetach(
    source: chrome.debugger.Debuggee,
    reason: `${chrome.debugger.DetachReason}`
  ): void {
    const tabId = source.tabId;
    if (!tabId || !tabs.has(tabId)) {
      return;
    }

    logger.debug(`Debugger detached for tab ${tabId}: ${reason}`);

    const tab = tabs.get(tabId);
    if (tab) {
      sendMessage({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId: tab.sessionId, targetId: tab.targetId },
        },
      });
    }

    // Clean up child sessions
    for (const [childSessionId, parentTabId] of childSessions) {
      if (parentTabId === tabId) {
        childSessions.delete(childSessionId);
      }
    }

    tabs.delete(tabId);
    void updateIcons();
  }

  // ============================================================================
  // Tab Attachment
  // ============================================================================

  async function attachTab(tabId: number): Promise<TargetInfo> {
    const debuggee = { tabId };

    logger.debug("Attaching debugger to tab:", tabId);
    await chrome.debugger.attach(debuggee, "1.3");

    const result = (await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo")) as {
      targetInfo: TargetInfo;
    };

    const targetInfo = result.targetInfo;
    const sessionId = `pw-tab-${nextSessionId++}`;

    tabs.set(tabId, {
      sessionId,
      targetId: targetInfo.targetId,
      state: "connected",
    });

    // Notify relay of new target
    sendMessage({
      method: "forwardCDPEvent",
      params: {
        method: "Target.attachedToTarget",
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    });

    logger.log("Tab attached:", tabId, "sessionId:", sessionId, "url:", targetInfo.url);
    void updateIcons();
    return targetInfo;
  }

  function detachTab(tabId: number, shouldDetachDebugger: boolean): void {
    const tab = tabs.get(tabId);
    if (!tab) return;

    logger.debug("Detaching tab:", tabId);

    sendMessage({
      method: "forwardCDPEvent",
      params: {
        method: "Target.detachedFromTarget",
        params: { sessionId: tab.sessionId, targetId: tab.targetId },
      },
    });

    tabs.delete(tabId);

    // Clean up child sessions
    for (const [childSessionId, parentTabId] of childSessions) {
      if (parentTabId === tabId) {
        childSessions.delete(childSessionId);
      }
    }

    if (shouldDetachDebugger) {
      chrome.debugger.detach({ tabId }).catch((err) => {
        logger.debug("Error detaching debugger:", err);
      });
    }

    void updateIcons();
  }

  // ============================================================================
  // WebSocket Connection
  // ============================================================================

  // Connection manager state
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const RECONNECT_INTERVAL = 3000; // 3 seconds

  /**
   * Maintains connection to relay server with periodic reconnection.
   * Called on startup and after disconnects.
   */
  function maintainConnection(): void {
    // Clear any existing timer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // Try to connect (async, don't await)
    tryConnect().catch(() => {
      // Errors handled inside tryConnect
    });

    // Schedule next check
    reconnectTimer = setTimeout(maintainConnection, RECONNECT_INTERVAL);
  }

  /**
   * Attempts to connect to the relay server once.
   * Does not retry - maintainConnection handles retries.
   */
  async function tryConnect(): Promise<void> {
    if (ws?.readyState === WebSocket.OPEN) {
      return;
    }

    // Check if server is available
    try {
      await fetch("http://localhost:9222", { method: "HEAD" });
    } catch {
      // Server not available, will retry on next maintainConnection cycle
      return;
    }

    logger.debug("Connecting to relay server...");
    const socket = new WebSocket(RELAY_URL);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 5000);

      socket.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };

      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      };

      socket.onclose = (event) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket closed: ${event.reason || event.code}`));
      };
    });

    ws = socket;

    ws.onmessage = async (event: MessageEvent) => {
      let message: ExtensionCommandMessage;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        logger.debug("Error parsing message:", error);
        sendMessage({
          error: { code: -32700, message: "Parse error" },
        });
        return;
      }

      const response: ExtensionResponseMessage = { id: message.id };
      try {
        response.result = await handleCommand(message);
      } catch (error) {
        logger.debug("Error handling command:", error);
        response.error = (error as Error).message;
      }
      sendMessage(response);
    };

    ws.onclose = (event: CloseEvent) => {
      logger.debug("Connection closed:", event.code, event.reason);

      // Detach all tabs on disconnect
      for (const tabId of tabs.keys()) {
        chrome.debugger.detach({ tabId }).catch(() => {});
      }
      tabs.clear();
      childSessions.clear();
      ws = null;

      void updateIcons();

      // Trigger reconnection attempt
      maintainConnection();
    };

    ws.onerror = (event: Event) => {
      logger.debug("WebSocket error:", event);
    };

    // Set up debugger event listeners (only add once)
    if (!chrome.debugger.onEvent.hasListener(onDebuggerEvent)) {
      chrome.debugger.onEvent.addListener(onDebuggerEvent);
    }
    if (!chrome.debugger.onDetach.hasListener(onDebuggerDetach)) {
      chrome.debugger.onDetach.addListener(onDebuggerDetach);
    }

    logger.log("Connected to relay server");
    void updateIcons();
  }

  /**
   * Ensures connection is established, used when user clicks to attach a tab.
   * Will wait for connection if relay is starting up.
   */
  async function ensureConnection(): Promise<void> {
    if (ws?.readyState === WebSocket.OPEN) {
      return;
    }

    // Try immediately
    await tryConnect();

    // If still not connected, wait a bit and try again
    if (ws?.readyState !== WebSocket.OPEN) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await tryConnect();
    }

    if (ws?.readyState !== WebSocket.OPEN) {
      throw new Error("Could not connect to relay server");
    }
  }

  // ============================================================================
  // Icon State Management
  // ============================================================================

  async function updateIcons(): Promise<void> {
    const allTabs = await chrome.tabs.query({});

    for (const tab of allTabs) {
      if (!tab.id) continue;

      const tabInfo = tabs.get(tab.id);
      const isConnected = tabInfo?.state === "connected";
      const isRestricted = isRestrictedUrl(tab.url);

      // Set icon color based on state
      if (isConnected) {
        await chrome.action.setIcon({
          tabId: tab.id,
          path: {
            16: "/icons/icon-green-16.png",
            32: "/icons/icon-green-32.png",
            48: "/icons/icon-green-48.png",
            128: "/icons/icon-green-128.png",
          },
        });
        await chrome.action.setTitle({
          tabId: tab.id,
          title: "Connected - Click to disconnect",
        });
      } else if (isRestricted) {
        await chrome.action.setIcon({
          tabId: tab.id,
          path: {
            16: "/icons/icon-gray-16.png",
            32: "/icons/icon-gray-32.png",
            48: "/icons/icon-gray-48.png",
            128: "/icons/icon-gray-128.png",
          },
        });
        await chrome.action.setTitle({
          tabId: tab.id,
          title: "Cannot attach to this page",
        });
      } else {
        await chrome.action.setIcon({
          tabId: tab.id,
          path: {
            16: "/icons/icon-black-16.png",
            32: "/icons/icon-black-32.png",
            48: "/icons/icon-black-48.png",
            128: "/icons/icon-black-128.png",
          },
        });
        await chrome.action.setTitle({
          tabId: tab.id,
          title: "Click to attach debugger",
        });
      }

      // Show badge with count of connected tabs
      const connectedCount = Array.from(tabs.values()).filter(
        (t) => t.state === "connected"
      ).length;
      if (connectedCount > 0) {
        await chrome.action.setBadgeText({
          tabId: tab.id,
          text: String(connectedCount),
        });
        await chrome.action.setBadgeBackgroundColor({
          tabId: tab.id,
          color: "#22c55e", // green
        });
      } else {
        await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
      }
    }
  }

  function isRestrictedUrl(url: string | undefined): boolean {
    if (!url) return true;
    const restrictedPrefixes = ["chrome://", "chrome-extension://", "devtools://", "edge://"];
    return restrictedPrefixes.some((prefix) => url.startsWith(prefix));
  }

  // ============================================================================
  // Action Click Handler
  // ============================================================================

  async function onActionClicked(tab: chrome.tabs.Tab): Promise<void> {
    if (!tab.id) {
      logger.debug("No tab ID available");
      return;
    }

    if (isRestrictedUrl(tab.url)) {
      logger.debug("Cannot attach to restricted URL:", tab.url);
      return;
    }

    const tabInfo = tabs.get(tab.id);

    if (tabInfo?.state === "connected") {
      // Disconnect
      detachTab(tab.id, true);
    } else {
      // Connect
      try {
        tabs.set(tab.id, { state: "connecting" });
        await updateIcons();

        await ensureConnection();
        await attachTab(tab.id);
      } catch (error) {
        logger.error("Failed to connect:", error);
        tabs.set(tab.id, {
          state: "error",
          errorText: (error as Error).message,
        });
        await updateIcons();
      }
    }
  }

  // ============================================================================
  // Event Listeners
  // ============================================================================

  chrome.action.onClicked.addListener(onActionClicked);

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabs.has(tabId)) {
      logger.debug("Tab closed:", tabId);
      detachTab(tabId, false);
    }
  });

  chrome.tabs.onUpdated.addListener(() => {
    void updateIcons();
  });

  // Reset any stale debugger connections on startup
  chrome.debugger.getTargets().then((targets) => {
    const attached = targets.filter((t) => t.tabId && t.attached);
    if (attached.length > 0) {
      logger.log(`Detaching ${attached.length} stale debugger connections`);
      for (const target of attached) {
        chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
      }
    }
  });

  logger.log("Extension initialized");
  void updateIcons();

  // Start connection manager - will auto-connect to relay and reconnect if disconnected
  maintainConnection();
});
