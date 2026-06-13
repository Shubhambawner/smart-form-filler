import { PROFILE_FIELDS } from './config.js';

// 1. Trigger the form-filling routine
document.getElementById('fillBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        chrome.tabs.sendMessage(tab.id, { action: "triggerAutofill" });
    }
});

// 2. Build the UI dynamically from config.js
const saveBtn = document.getElementById('saveBtn');

PROFILE_FIELDS.forEach(field => {
    const label = document.createElement('label');
    label.innerText = field.label;
    label.style.display = "block";
    label.style.fontSize = "11px";
    label.style.fontWeight = "bold";
    label.style.marginTop = "8px";
    label.style.color = "#4b5563";

    const input = document.createElement('input');
    input.type = "text";
    input.id = `input-${field.id}`;
    input.placeholder = field.defaultValue;
    input.style.width = "92%";
    input.style.padding = "6px";
    input.style.marginTop = "4px";
    input.style.border = "1px solid #ccc";
    input.style.borderRadius = "4px";

    document.body.insertBefore(label, saveBtn);
    document.body.insertBefore(input, saveBtn);
});

// 3. Persist updated configuration data
saveBtn.addEventListener('click', () => {
    const newProfile = {};
    PROFILE_FIELDS.forEach(field => {
        newProfile[field.id] = document.getElementById(`input-${field.id}`).value;
    });

    chrome.storage.local.set({ userProfile: newProfile }, () => {
        alert('Profile data saved successfully!');
    });
});

// 4. Hydrate form inputs with existing storage state
chrome.storage.local.get(['userProfile'], (result) => {
    const savedProfile = result.userProfile || {};
    PROFILE_FIELDS.forEach(field => {
        const input = document.getElementById(`input-${field.id}`);
        if (input && savedProfile[field.id]) {
            input.value = savedProfile[field.id];
        }
    });
});