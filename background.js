import { pipeline, env, dot } from './transformers.js';
import { PROFILE_FIELDS } from './config.js';

// 1. Allow remote model fetching (no local model files are bundled);
// the model is cached by the browser after the first download.
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.backends.onnx.wasm.numThreads = 1;

// 2. Explicitly map the WASM binaries to your local files in the root folder
env.backends.onnx.wasm.wasmPaths = {
    'ort-wasm.wasm': './ort-wasm.wasm',
    'ort-wasm-simd.wasm': './ort-wasm-simd.wasm',
    'ort-wasm-threaded.wasm': './ort-wasm-threaded.wasm',
    'ort-wasm-simd-threaded.wasm': './ort-wasm-simd-threaded.wasm'
};

let embedderPipeline = null;
let cachedTargetVectors = null;
const textEmbeddingCache = new Map();

// Initialize model
async function getEmbedder() {
    if (!embedderPipeline) {
        embedderPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    return embedderPipeline;
}

// Pre-compute and cache target vectors. Each field's context array is
// flattened so every phrase is embedded and matched individually; the
// highest-scoring phrase determines which field wins the match.
async function getTargetVectors() {
    if (cachedTargetVectors) return cachedTargetVectors;

    const embedder = await getEmbedder();
    cachedTargetVectors = [];

    for (const field of PROFILE_FIELDS) {
        for (const contextEntry of field.context) {
            const output = await embedder(contextEntry, { pooling: 'mean', normalize: true });
            cachedTargetVectors.push({ fieldId: field.id, vector: Array.from(output.data) });
        }
    }
    return cachedTargetVectors;
}

// Cheap first pass: check whether any context phrase appears as a whole-word
// match inside the label text (case-insensitive). Avoids the embedder entirely
// when an obvious lexical match exists.
function findRegexMatch(labelText) {
    const normalizedLabel = String(labelText).toLowerCase();

    for (const field of PROFILE_FIELDS) {
        for (const contextEntry of field.context) {
            const escaped = contextEntry.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(`\\b${escaped}\\b`);
            if (pattern.test(normalizedLabel)) {
                return field.id;
            }
        }
    }
    return null;
}

// Embed arbitrary text, caching by normalized text so repeated option labels
// (e.g. country names, "Yes"/"No") aren't re-embedded on every autofill pass.
async function embedText(text) {
    const key = String(text).toLowerCase().trim();
    if (textEmbeddingCache.has(key)) return textEmbeddingCache.get(key);

    const embedder = await getEmbedder();
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data);
    textEmbeddingCache.set(key, vector);
    return vector;
}

// Preload the embedding model on install so the first autofill is fast
chrome.runtime.onInstalled.addListener(() => {
    getEmbedder().catch(err => console.error("Embedder preload failed:", err));
});

// Listen for mapping requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getProfile") {
        chrome.storage.local.get(['userProfile'], (result) => {
            const saved = result.userProfile || {};
            const profile = {};
            PROFILE_FIELDS.forEach(field => {
                const value = saved[field.id];
                profile[field.id] = (value !== undefined && value !== '') ? value : field.defaultValue;
            });
            sendResponse({ profile });
        });
        return true;
    }
    else if (request.action === "findMatch") {
        (async () => {
            try {
                const regexMatch = findRegexMatch(request.labelText);
                if (regexMatch) {
                    sendResponse({ success: true, matchedKey: regexMatch, score: 1 });
                    return;
                }

                const embedder = await getEmbedder();
                const targets = await getTargetVectors();

                const inputVectorRaw = await embedder(request.labelText, { pooling: 'mean', normalize: true });
                const inputVector = Array.from(inputVectorRaw.data);

                let bestMatch = null;
                let highestScore = -1;

                for (const { fieldId, vector } of targets) {
                    const score = dot(inputVector, vector);
                    if (score > highestScore) {
                        highestScore = score;
                        bestMatch = fieldId;
                    }
                }

                if (highestScore > 0.0005) {
                    console.log({ success: true, matchedKey: bestMatch, score: highestScore })
                    sendResponse({ success: true, matchedKey: bestMatch, score: highestScore });
                } else {
                    sendResponse({ success: false, score: highestScore });
                }
            } catch (error) {
                console.error("Embedding Error:", error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }
    else if (request.action === "rankOptions") {
        (async () => {
            try {
                const { value, options } = request;
                const valueVector = await embedText(value);

                const scores = [];
                for (const optionText of options) {
                    const optionVector = await embedText(optionText);
                    scores.push(dot(valueVector, optionVector));
                }

                sendResponse({ success: true, scores });
            } catch (error) {
                console.error("Ranking Error:", error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }
});