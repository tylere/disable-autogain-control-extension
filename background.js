// Per-domain enable/disable. When the user grants permission for an origin we
// register a MAIN-world content script that runs at document_start, so the
// getUserMedia patch is installed before any page script can call it. This
// removes the race inherent in reacting to tabs.onUpdated from the service
// worker (async permission check + executeScript could lose to early callers).

const SCRIPT_ID_PREFIX = "disable-autogain:";

// In-memory mirror of the http/https origins we currently have permission for.
// chrome.permissions.request() must be the first awaited call in the action
// click handler to keep the user gesture, so the enable/disable decision has
// to be made synchronously — hence this set rather than an await on
// permissions.contains(). Kept in sync by reconcileRegistrations() and
// re-hydrated on every service-worker spin-up.
const enabledOrigins = new Set();

async function hydrateEnabledOrigins() {
    try {
        const { origins = [] } = await chrome.permissions.getAll();
        enabledOrigins.clear();
        for (const p of origins) {
            if (p.startsWith("http://") || p.startsWith("https://")) {
                enabledOrigins.add(originFromPattern(p));
            }
        }
    } catch (e) {
        console.error("Failed to hydrate enabled origins", e);
    }
}

/** "https://example.com" -> stable, unique content-script id */
function scriptIdForOrigin(origin) {
    return SCRIPT_ID_PREFIX + origin;
}

/** Granted origin pattern ("https://example.com/*") -> "https://example.com" */
function originFromPattern(pattern) {
    return pattern.replace(/\/\*$/, "");
}

function contentScriptFor(origin) {
    return {
        id: scriptIdForOrigin(origin),
        matches: [origin + "/*"],
        js: ["disableAutogain.js"],
        world: "MAIN",
        runAt: "document_start",
        allFrames: true,
    };
}

async function registerForOrigin(origin) {
    const id = scriptIdForOrigin(origin);
    try {
        const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
        if (existing.length) {
            return;
        }
        await chrome.scripting.registerContentScripts([contentScriptFor(origin)]);
    } catch (e) {
        console.error("Failed to register content script for", origin, e);
    }
}

async function unregisterForOrigin(origin) {
    try {
        await chrome.scripting.unregisterContentScripts({ ids: [scriptIdForOrigin(origin)] });
    } catch (e) {
        // Not registered (or already gone) — nothing to do.
    }
}

/**
 * Make registered content scripts match exactly the http/https origins the
 * extension currently has permission for. Covers permissions changed outside
 * our own handlers (e.g. revoked via chrome://extensions) and registration
 * drift across updates.
 */
async function reconcileRegistrations() {
    try {
        const { origins = [] } = await chrome.permissions.getAll();
        const wanted = new Set(
            origins
                .filter(p => p.startsWith("http://") || p.startsWith("https://"))
                .map(originFromPattern)
        );

        // Keep the synchronous mirror used by the click handler in sync,
        // including permissions changed via chrome://extensions.
        enabledOrigins.clear();
        for (const o of wanted) {
            enabledOrigins.add(o);
        }

        let registered = [];
        try {
            registered = await chrome.scripting.getRegisteredContentScripts();
        } catch (e) {
            registered = [];
        }
        const ours = registered.filter(s => s.id.startsWith(SCRIPT_ID_PREFIX));
        const haveIds = new Set(ours.map(s => s.id));

        const staleIds = ours
            .filter(s => !wanted.has(s.id.slice(SCRIPT_ID_PREFIX.length)))
            .map(s => s.id);
        if (staleIds.length) {
            try {
                await chrome.scripting.unregisterContentScripts({ ids: staleIds });
            } catch (e) {
                console.error("Failed to unregister stale content scripts", e);
            }
        }

        const toAdd = [];
        for (const origin of wanted) {
            if (!haveIds.has(scriptIdForOrigin(origin))) {
                toAdd.push(contentScriptFor(origin));
            }
        }
        if (toAdd.length) {
            try {
                await chrome.scripting.registerContentScripts(toAdd);
            } catch (e) {
                console.error("Failed to register content scripts", e);
            }
        }
    } catch (e) {
        console.error("Failed to reconcile content-script registrations", e);
    }
}

async function updateActionState(tabId, origin) {
    const hasPermission = await chrome.permissions.contains({ origins: [origin + "/*"] });
    await chrome.action.setTitle({
        title: hasPermission ? "Disable Automatic Gain Control" : "Enable Automatic Gain Control",
        tabId,
    });
    await chrome.action.setBadgeText({
        text: hasPermission ? "On" : "",
        tabId,
    });
}

chrome.action.onClicked.addListener(async (tab) => {
    // Parse synchronously: chrome.permissions.request() below must be the
    // first awaited call or Chrome drops the user gesture and throws
    // "This function must be called during a user gesture".
    let origin;
    try {
        const url = new URL(tab.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            // Only handle http/https URLs
            return;
        }
        origin = url.origin;
    } catch (e) {
        // tab.url is undefined for restricted pages (chrome://, Web Store)
        // even with activeTab; log so real failures are not hidden.
        console.warn("Could not toggle for this tab:", e);
        return;
    }

    const originPattern = origin + "/*";
    try {
        if (enabledOrigins.has(origin)) {
            enabledOrigins.delete(origin);
            await chrome.permissions.remove({ origins: [originPattern] });
            await unregisterForOrigin(origin);
        } else {
            // First awaited call — keeps the user gesture intact.
            const granted = await chrome.permissions.request({ origins: [originPattern] });
            if (!granted) {
                return;
            }
            enabledOrigins.add(origin);
            await registerForOrigin(origin);
        }
        await updateActionState(tab.id, origin);
        chrome.tabs.reload(tab.id);
    } catch (e) {
        console.warn("Could not toggle for this tab:", e);
    }
});

// Keep the toolbar badge/title in sync when switching tabs (no injection here,
// the registered content script handles that).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.url) {
            return;
        }
        const { origin, protocol } = new URL(tab.url);
        if (protocol !== "http:" && protocol !== "https:") {
            return;
        }
        await updateActionState(tabId, origin);
    } catch (e) {
        // Restricted/unknown tab — leave the default action state.
    }
});

function showUsage() {
    chrome.tabs.create({
        url: chrome.runtime.getURL("usage.html")
    });
}

function showUpgradeNotice() {
    chrome.tabs.create({
        url: chrome.runtime.getURL("upgradeFromV1.0.html")
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (typeof message === "object" && message["type"] === "enable-meet-hangouts") {
        const origins = [
            "https://meet.google.com/*",
            "https://hangouts.google.com/*"
        ];
        chrome.permissions.request({ origins }).then(async (granted) => {
            if (granted) {
                for (const p of origins) {
                    enabledOrigins.add(originFromPattern(p));
                }
                await Promise.all(origins.map(p => registerForOrigin(originFromPattern(p))));
            }
            sendResponse(granted);
        });
        return true;
    }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "usage-menu-item") {
        showUsage();
    }
});

// Permissions can change outside our handlers (chrome://extensions, sync).
chrome.permissions.onAdded.addListener(reconcileRegistrations);
chrome.permissions.onRemoved.addListener(reconcileRegistrations);

chrome.runtime.onStartup.addListener(reconcileRegistrations);

// onStartup only fires at browser launch, not when the service worker wakes
// from idle, so repopulate the synchronous mirror on every spin-up.
hydrateEnabledOrigins();

chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
    chrome.contextMenus.create({
        id: "usage-menu-item",
        title: "Usage",
        contexts: ["action"]
    });
    reconcileRegistrations();
    if (reason === "update" && previousVersion === "1.0") {
        showUpgradeNotice();
    } else if (reason === "install") {
        showUsage();
    }
});
