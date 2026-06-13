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

// Initialize model
async function getEmbedder() {
    if (!embedderPipeline) {
        embedderPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    return embedderPipeline;
}

// Pre-compute and cache target vectors
async function getTargetVectors() {
    if (cachedTargetVectors) return cachedTargetVectors;

    const embedder = await getEmbedder();
    cachedTargetVectors = {};

    for (const field of PROFILE_FIELDS) {
        const output = await embedder(field.context, { pooling: 'mean', normalize: true });
        cachedTargetVectors[field.id] = Array.from(output.data);
    }
    return cachedTargetVectors;
}

// Install listener to set default data on first load
chrome.runtime.onInstalled.addListener(() => {
    getEmbedder().catch(err => console.error("Embedder preload failed:", err));
    chrome.storage.local.get(['userProfile'], (result) => {
        if (!result.userProfile) {
            const defaultProfile = {};
            PROFILE_FIELDS.forEach(f => defaultProfile[f.id] = f.defaultValue);
            chrome.storage.local.set({ userProfile: defaultProfile });
        }
    });
});

// Listen for mapping requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "findMatch") {
        (async () => {
            try {
                const embedder = await getEmbedder();
                const targets = await getTargetVectors();

                const inputVectorRaw = await embedder(request.labelText, { pooling: 'mean', normalize: true });
                const inputVector = Array.from(inputVectorRaw.data);

                let bestMatch = null;
                let highestScore = -1;

                for (const [key, targetVector] of Object.entries(targets)) {
                    const score = dot(inputVector, targetVector);
                    if (score > highestScore) {
                        highestScore = score;
                        bestMatch = key;
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
});