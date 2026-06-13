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

// Semantically ranks each option against the target value and returns the
// index with the highest similarity score.
function rankOptions(targetValue, optionTexts, onBest) {
    chrome.runtime.sendMessage({ action: "rankOptions", value: String(targetValue), options: optionTexts }, (response) => {
        if (!response?.success) return;

        let bestIndex = -1;
        let highestScore = -Infinity;
        response.scores.forEach((score, i) => {
            if (optionTexts[i] && score > highestScore) {
                highestScore = score;
                bestIndex = i;
            }
        });

        if (bestIndex === -1) return;
        onBest(bestIndex, highestScore);
    });
}

function handleDropdown(selectEl, targetValue) {
    const options = Array.from(selectEl.options);
    if (options.length === 0) return;

    const optionTexts = options.map(o => o.text.trim());

    rankOptions(targetValue, optionTexts, (bestIndex, highestScore) => {
        const bestOption = options[bestIndex];
        selectEl.value = bestOption.value;

        // Dispatch sequence for framework detection
        ['input', 'change', 'blur'].forEach(type => {
            selectEl.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
        });

        console.log(`✅ Selected "${bestOption.text}" (Score: ${highestScore.toFixed(3)}) for target "${targetValue}"`);
    });
}
// Core filling engine

function autoFillForm() {
    chrome.runtime.sendMessage({ action: "getProfile" }, (response) => {
        const savedUserProfile = response?.profile || {};

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
        .map(t => t.trim())
        .filter(Boolean);

    if (inputs.length > 1 && inputs[0].type === 'checkbox' && targets.length > 1) {
        targets.forEach(target => selectBestChoice(inputs, target));
        return;
    }

    selectBestChoice(inputs, targets[0] ?? String(targetValue).trim());
}

function selectBestChoice(inputs, target) {
    const optionTexts = inputs.map(input => (input.labels && input.labels[0]) ? input.labels[0].innerText.trim() : "");
    if (!optionTexts.some(Boolean)) return;

    rankOptions(target, optionTexts, (bestIndex, highestScore) => {
        const bestMatch = inputs[bestIndex];
        bestMatch.checked = true;
        bestMatch.dispatchEvent(new Event('change', { bubbles: true }));
        bestMatch.dispatchEvent(new Event('click', { bubbles: true })); // Some forms need the click event
        console.log(`✅ Selected "${optionTexts[bestIndex]}" (Score: ${highestScore.toFixed(3)})`);
    });
}


// Boot up
waitForFormToRender();
