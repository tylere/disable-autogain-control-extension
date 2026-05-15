// Show context menu that allows enabling/disabling on a per-domain basis.

chrome.action.onClicked.addListener(async (tab) => {
    try {
        const url = new URL(tab.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            // Only handle http/https URLs
            return;
        }
        const { origin } = url;
        const hasPermission = await chrome.permissions.contains({
            origins: [origin + "/*"]
        });
        if (hasPermission) {
            await chrome.permissions.remove({ origins: [origin + "/*"] });
            chrome.tabs.reload(tab.id);
        } else {
            await chrome.permissions.request({ origins: [origin + "/*"] });
            chrome.tabs.reload(tab.id);
        }
    } catch (e) {
        // tab.url is undefined for restricted pages (chrome://, Web Store)
        // even with activeTab; log so real failures are not hidden.
        console.warn("Could not toggle for this tab:", e);
    }
});


chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    injectScriptIfNecessary(tab);
});

/**
 * @param {chrome.tabs.Tab} tab 
 */

async function injectScriptIfNecessary(tab) {
    if (tab.status !== "loading" || !tab.url) {
        return;
    }
    try {
        const { origin, protocol } = new URL(tab.url);
        if (protocol !== "https:" && protocol !== "http:") {
            return;
        }
        const hasPermission = await chrome.permissions.contains({ origins: [origin + "/*"] });
        if (hasPermission) {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                files: ["disableAutogain.js"],
                world: "MAIN",
                injectImmediately: true,
            });
        }
        await chrome.action.setTitle({
            title: hasPermission ? "Disable Automatic Gain Control" : "Enable Automatic Gain Control",
            tabId: tab.id,
        });
        await chrome.action.setBadgeText({
            text: hasPermission ? "On" : "",
            tabId: tab.id,
        });
    } catch (e) {
        console.error("Failed to inject script", e);
    }
}


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
        chrome.permissions.request({
            origins: [
                "https://meet.google.com/*",
                "https://hangouts.google.com/*"
            ]
        }).then((granted) => {
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


chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
    chrome.contextMenus.create({
        id: "usage-menu-item",
        title: "Usage",
        contexts: ["action"]
    });
    if (reason === "update" && previousVersion === "1.0") {
        showUpgradeNotice();
    } else if (reason === "install") {
        showUsage();
    }
});
