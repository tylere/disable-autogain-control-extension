# Disable Automatic Gain Control (Chrome Extension)

 originally from [here](https://github.com/joeywatts/disable-autogain-control-extension)

refer [here](https://support.google.com/chrome/thread/7542181?hl=en) for why this extension exist.

# Installation 
1. Download the source code as a zip file and extract it to a folder.
2. Visit "chrome://extensions" in your address bar.
3. Toggle "Developer mode" and click "Load unpacked"
4. Select the extracted folder.
5. You should see "disable-autogain-gmeet" in your extensions list.

Note: there's no associated UI with the extension, as long as it is activated in your extensions list, it always disables the automatic gain control.

# Testing checklist

After loading the unpacked extension, verify:

1. The install prompt does **not** warn about reading your data on all sites (host access is now requested per-domain).
2. Visit a site such as `https://meet.google.com` and click the extension's toolbar button — Chrome prompts for permission on that origin and the badge shows "On".
3. With the domain enabled, automatic gain control is disabled there.
4. On a domain you have **not** enabled, autogain is unaffected.
5. Click the toolbar button again to revoke — the badge clears, the page reloads, and autogain is restored.

> Note: I am not intrested to list this as extension on chrome web store, if you want plz go ahead and do it.