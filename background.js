// background.js

chrome.runtime.onInstalled.addListener(() => {
  updateDynamicRules();
});

// Sync custom user additions whenever storage updates
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.blockedSites) {
    updateDynamicRules();
  }
  // Handle toggling preset lists (Ads, Adult, Gambling switches)
  if (area === 'local' && changes.toggles) {
    const toggles = changes.toggles.newValue;
    chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: [
        toggles.ads ? 'ads_rules' : [],
        toggles.adult ? 'adult_rules' : [],
        toggles.gambling ? 'gambling_rules' : []
      ].flat(),
      disableRulesetIds: [
        !toggles.ads ? 'ads_rules' : [],
        !toggles.adult ? 'adult_rules' : [],
        !toggles.gambling ? 'gambling_rules' : []
      ].flat()
    });
  }
});

async function updateDynamicRules() {
  chrome.storage.local.get(['blockedSites'], async (data) => {
    const sites = data.blockedSites || [];
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingRuleIds = existingRules.map(rule => rule.id);

    // Dynamic user-added rules start at ID 1000 to avoid static rule collision
    const newRules = sites.map((site, index) => {
      const cleanDomain = site.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
      return {
        id: 1000 + index,
        priority: 2,
        action: {
          type: "redirect",
          redirect: {
            url: chrome.runtime.getURL(`blocked.html?site=${encodeURIComponent(cleanDomain)}&category=Custom Block`)
          }
        },
        condition: {
          urlFilter: `||${cleanDomain}`,
          resourceTypes: ["main_frame"]
        }
      };
    });

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingRuleIds,
      addRules: newRules
    });
  });
}
