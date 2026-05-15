// Per-domain enable/disable. When the user grants permission for an origin we
// register a MAIN-world content script that runs at document_start, so the
// getUserMedia patch is installed before any page script can call it. This
// removes the race inherent in reacting to tabs.onUpdated from the service
// worker (async permission check + executeScript could lose to early callers).

const SCRIPT_ID_PREFIX = "disable-autogain:";

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
    try {
        const url = new URL(tab.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            // Only handle http/https URLs
            return;
        }
        const { origin } = url;
        const originPattern = origin + "/*";
        const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
        if (hasPermission) {
            await chrome.permissions.remove({ origins: [originPattern] });
            await unregisterForOrigin(origin);
        } else {
            const granted = await chrome.permissions.request({ origins: [originPattern] });
            if (!granted) {
                return;
            }
            await registerForOrigin(origin);
        }
        await updateActionState(tab.id, origin);
        chrome.tabs.reload(tab.id);
    } catch (e) {
        // tab.url is undefined for restricted pages (chrome://, Web Store)
        // even with activeTab; log so real failures are not hidden.
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
