// Collapse whitespace/markup noise from extracted text
function cleanText(text) {
    return (text || "")
        .replace(/[*:\n\r]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Function to collect semantic layout context from input environments
function extractContextClues(input) {
    let clues = [input.placeholder, input.name, input.id, input.getAttribute('aria-label')].filter(Boolean);

    if (input.id) {
        const boundLabel = document.querySelector(`label[for="${input.id}"]`);
        if (boundLabel && boundLabel.innerText) clues.push(boundLabel.innerText);
    }

    const parentLabel = input.closest('label');
    if (parentLabel && parentLabel.innerText) clues.push(parentLabel.innerText);

    const container = input.closest('div, td, li, section');
    if (container) {
        const nearbyLabel = container.querySelector('label');
        if (nearbyLabel && nearbyLabel.innerText) {
            clues.push(nearbyLabel.innerText);
        } else {
            clues.push(container.innerText);
        }
    }

    return cleanText(clues.join(" "));
}

// For a radio/checkbox group, find the overarching question text rather than
// any single option's own label (e.g. "Are you eligible to work in India?"
// instead of just "Yes" or "No").
function extractGroupContext(groupInputs) {
    if (groupInputs.length === 1) {
        return extractContextClues(groupInputs[0]);
    }

    const boundary = groupInputs[0].closest('form') || document.body;

    let ancestor = groupInputs[0].parentElement;
    while (ancestor && ancestor !== boundary && !groupInputs.every(el => ancestor.contains(el))) {
        ancestor = ancestor.parentElement;
    }
    if (!ancestor) ancestor = boundary;

    // Climb one extra level to catch a sibling question label/legend
    if (ancestor.parentElement && ancestor !== boundary) {
        ancestor = ancestor.parentElement;
    }

    const legend = ancestor.querySelector('legend');
    if (legend && legend.innerText.trim()) {
        return cleanText(legend.innerText);
    }

    const clone = ancestor.cloneNode(true);
    clone.querySelectorAll('input, select, textarea, script, style').forEach(n => n.remove());
    return cleanText(clone.innerText);
}

// React-friendly setter to force frameworks to recognize the value change
function setReactValue(input, value) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeInputValueSetter.call(input, value);

    // Dispatch required event chain to trigger UI state updates
    ['input', 'change', 'blur'].forEach(type => {
        input.dispatchEvent(new Event(type, { bubbles: true }));
    });
}

function handleDropdown(selectEl, targetValue) {
    const options = Array.from(selectEl.options);
    const target = String(targetValue).toLowerCase();

    let bestMatch = null;
    let highestScore = 0;

    options.forEach(option => {
        const optionText = option.text.toLowerCase().trim();

        // Scoring logic:
        // 1. Perfect Match: Score 1.0
        // 2. Contains Target: Score 0.8
        // 3. Target Contains Option: Score 0.6
        let score = 0;
        if (optionText === target) score = 1.0;
        else if (optionText.includes(target)) score = 0.8;
        else if (target.includes(optionText)) score = 0.6;

        if (score > highestScore) {
            highestScore = score;
            bestMatch = option;
        }
    });

    if (bestMatch && highestScore > 0) {
        selectEl.value = bestMatch.value;

        // Dispatch sequence for framework detection
        ['input', 'change', 'blur'].forEach(type => {
            selectEl.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
        });

        console.log(`✅ Selected "${bestMatch.text}" (Score: ${highestScore}) for target "${targetValue}"`);
    } else {
        console.warn(`⚠️ No match found for "${targetValue}" in dropdown: ${selectEl.name}`);
    }
}
// Core filling engine

function autoFillForm() {
    chrome.storage.local.get(['userProfile'], (result) => {
        const savedUserProfile = result.userProfile || {};

        // Radio/checkbox groups are matched as a group, not individually
        processChoiceGroups(savedUserProfile);

        const elements = document.querySelectorAll('input, select, textarea');

        elements.forEach(el => {
            if (el.dataset.smartFilled === "true") return;
            if (['radio', 'checkbox'].includes(el.type)) return;

            const labelContext = extractContextClues(el);
            if (!labelContext) return;

            el.dataset.smartFilled = "true";

            chrome.runtime.sendMessage({ action: "findMatch", labelText: labelContext }, (response) => {
                if (response?.success && savedUserProfile[response.matchedKey] !== undefined) {
                    const value = savedUserProfile[response.matchedKey];
                    routeFilling(el, value);
                } else {
                    el.removeAttribute('data-smart-filled');
                }
            });
        });
    });
}

// Groups radio/checkbox inputs by their shared "name" (or treats them as a
// solo group when unnamed) and resolves one semantic match per group.
function processChoiceGroups(savedUserProfile) {
    const choiceInputs = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'))
        .filter(el => el.dataset.smartFilled !== "true");

    const groups = new Map();
    choiceInputs.forEach(el => {
        const key = el.name || `__solo_${groups.size}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(el);
    });

    groups.forEach(groupInputs => {
        const labelContext = extractGroupContext(groupInputs);
        if (!labelContext) return;

        groupInputs.forEach(el => el.dataset.smartFilled = "true");

        chrome.runtime.sendMessage({ action: "findMatch", labelText: labelContext }, (response) => {
            if (response?.success && savedUserProfile[response.matchedKey] !== undefined) {
                handleMultiChoice(groupInputs, savedUserProfile[response.matchedKey]);
            } else {
                groupInputs.forEach(el => el.removeAttribute('data-smart-filled'));
            }
        });
    });
}

function routeFilling(el, value) {
    // 1. Trivial Text Input
    if (el.tagName === 'INPUT' && ['text', 'email', 'tel', 'password'].includes(el.type)) {
        setReactValue(el, value);
    }
    // 2. Standard Select Dropdown
    else if (el.tagName === 'SELECT') {
        handleDropdown(el, value);
    }
    // 3. Dynamic Dropdown (Type-ahead/Async)
    else if (el.classList.contains('async-select') || el.getAttribute('role') === 'combobox') {
        el.focus();
        setReactValue(el, value); // Simulate typing
        // Logic to wait for results, then trigger click
    }
    // 4. File Input
    else if (el.type === 'file') {
        console.log("File detected: Manual upload required.");
    }
}

// ⏳ Smart Polling & Observation
let checkAttempts = 0;
function waitForFormToRender() {
    const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]), textarea');
    if (inputs.length > 0) {
        autoFillForm();
        attachLazyObserver();
    } else if (checkAttempts < 20) {
        checkAttempts++;
        setTimeout(waitForFormToRender, 500);
    }
}

function attachLazyObserver() {
    let debounceTimer;
    const observer = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(autoFillForm, 800);
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

// Choices: handles radio groups (single answer like Yes/No) and checkbox
// groups (multi-select like "which countries are you eligible in").
function handleMultiChoice(inputs, targetValue) {
    const targets = String(targetValue)
        .split(/\s*[,;]\s*|\s+and\s+/i)
        .map(t => t.trim().toLowerCase())
        .filter(Boolean);

    if (inputs.length > 1 && inputs[0].type === 'checkbox' && targets.length > 1) {
        targets.forEach(target => selectBestChoice(inputs, target));
        return;
    }

    selectBestChoice(inputs, targets[0] ?? String(targetValue).toLowerCase().trim());
}

function selectBestChoice(inputs, target) {
    let bestMatch = null;
    let highestScore = 0;

    inputs.forEach(input => {
        // Look for the text label associated with this specific button
        const labelText = (input.labels && input.labels[0]) ? input.labels[0].innerText : "";
        const optionText = labelText.toLowerCase().trim();

        // Scoring: 1.0 for exact, 0.8 for partial, 0.5 for keyword match
        let score = 0;
        if (optionText === target) score = 1.0;
        else if (optionText.includes(target)) score = 0.8;
        else if (target.includes(optionText)) score = 0.5;

        if (score > highestScore) {
            highestScore = score;
            bestMatch = input;
        }
    });

    if (bestMatch && highestScore > 0.3) { // 0.3 threshold to avoid random guessing
        bestMatch.checked = true;
        bestMatch.dispatchEvent(new Event('change', { bubbles: true }));
        bestMatch.dispatchEvent(new Event('click', { bubbles: true })); // Some forms need the click event
        console.log(`✅ Selected "${bestMatch.labels[0].innerText}" (Score: ${highestScore})`);
    }
}


// Boot up
waitForFormToRender();
