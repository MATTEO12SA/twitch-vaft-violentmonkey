// Keep this factory self-contained: the same implementation runs in the page and Worker.
function createNetworkTools(env = globalThis) {
    const GQL_URL = 'https://gql.twitch.tv/gql';
    const MAX_OPERATION_BYTES = 1024 * 1024;
    const REQUEST_TIMEOUT = 8000;

    function isRequest(input) {
        return typeof env.Request === 'function' && input instanceof env.Request;
    }

    function readFetchURL(input, base) {
        try {
            const value = isRequest(input) ? input.url : input;
            if (typeof value !== 'string' && !(value instanceof env.URL)) return null;
            return new env.URL(value, base);
        } catch {
            return null;
        }
    }

    function effectiveHeaders(input, init) {
        return new env.Headers(init?.headers !== undefined
            ? init.headers
            : isRequest(input) ? input.headers : undefined);
    }

    function effectiveSignal(input, init) {
        return init?.signal !== undefined ? init.signal : isRequest(input) ? input.signal : null;
    }

    function makeError(message, name) {
        if (typeof env.DOMException === 'function') return new env.DOMException(message, name);
        const error = new Error(message);
        error.name = name;
        return error;
    }

    function cancelBody(body) {
        try {
            // Cancelling a cloned Request's tee can wait for the other branch. Never await it.
            const pending = body?.cancel();
            if (pending && typeof pending.catch === 'function') pending.catch(() => {});
        } catch {}
    }

    async function readOperationText(input, init) {
        // A stream supplied directly in init belongs to the caller. Do not consume it.
        if (init?.body != null) {
            return typeof init.body === 'string' && init.body.length <= MAX_OPERATION_BYTES
                ? init.body : null;
        }
        if (!isRequest(input) || input.bodyUsed || !input.body) return null;
        const signal = effectiveSignal(input, init);
        if (signal?.aborted) return null;
        const clone = input.clone();
        const reader = clone.body.getReader();
        let timer;
        let onAbort;
        const stopReading = () => cancelBody(reader);
        try {
            const reading = (async () => {
                const decoder = new env.TextDecoder();
                let length = 0;
                let text = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) return text + decoder.decode();
                    length += value.byteLength;
                    if (length > MAX_OPERATION_BYTES) return null;
                    text += decoder.decode(value, { stream: true });
                }
            })();
            const cancelled = new Promise(resolve => {
                const stop = () => { stopReading(); resolve(null); };
                timer = env.setTimeout(stop, REQUEST_TIMEOUT);
                onAbort = stop;
                signal?.addEventListener('abort', onAbort, { once: true });
                if (signal?.aborted) stop();
            });
            return await Promise.race([reading, cancelled]);
        } catch {
            return null;
        } finally {
            env.clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            stopReading();
        }
    }

    async function rewritePlaybackRequest(input, init, playerType, base) {
        const result = { input, init, operations: [], headers: null };
        const url = readFetchURL(input, base);
        // Never inspect bodies or credentials from other origins or other GraphQL paths.
        if (!url || url.href !== GQL_URL) return result;
        result.headers = effectiveHeaders(input, init);
        const text = await readOperationText(input, init);
        if (text === null) return result;
        let body;
        try { body = JSON.parse(text); } catch { return result; }
        const operations = Array.isArray(body) ? body : [body];
        result.operations = operations;
        if (typeof playerType !== 'string' || !playerType) return result;
        let changed = false;
        const rewritten = operations.map(operation => {
            const variables = operation?.variables;
            if (operation?.operationName !== 'PlaybackAccessToken' ||
                variables?.isLive !== true || variables?.isVod !== false ||
                variables.playerType === playerType) return operation;
            changed = true;
            return { ...operation, variables: { ...variables, playerType } };
        });
        if (changed) {
            // RequestInit overrides just the body; Request headers, credentials and signal survive.
            result.init = { ...init, body: JSON.stringify(Array.isArray(body) ? rewritten : rewritten[0]) };
        }
        return result;
    }

    async function requestText(fetcher, input, init = {}, timeoutMs = REQUEST_TIMEOUT, maxBytes = MAX_OPERATION_BYTES) {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
            throw new RangeError('timeoutMs must be a finite, non-negative number');
        }
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
            throw new RangeError('maxBytes must be a non-negative safe integer');
        }
        const signal = effectiveSignal(input, init);
        if (signal?.aborted) throw signal.reason ?? makeError('The request was aborted', 'AbortError');
        const controller = new env.AbortController();
        let response;
        let timer;
        let onAbort;
        let cancellationReason;
        let reader;
        const cancelled = new Promise((resolve, reject) => {
            const stop = reason => {
                if (controller.signal.aborted) return;
                cancellationReason = reason;
                controller.abort(reason);
                cancelBody(reader ?? response?.body);
                reject(reason);
            };
            timer = env.setTimeout(() => stop(makeError('Auxiliary request timed out', 'TimeoutError')), timeoutMs);
            onAbort = () => stop(signal.reason ?? makeError('The request was aborted', 'AbortError'));
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
        });
        const reading = (async () => {
            let completed = false;
            try {
                response = await fetcher(input, { ...init, signal: controller.signal });
                if (controller.signal.aborted) {
                    cancelBody(response?.body);
                    throw cancellationReason;
                }
                let text = '';
                if (response.body?.getReader) {
                    reader = response.body.getReader();
                    const decoder = new env.TextDecoder();
                    let byteLength = 0;
                    while (true) {
                        const chunk = await reader.read();
                        if (controller.signal.aborted) throw cancellationReason;
                        if (chunk.done) break;
                        byteLength += chunk.value.byteLength;
                        if (byteLength > maxBytes) throw new RangeError('Auxiliary response exceeds byte limit');
                        text += decoder.decode(chunk.value, { stream: true });
                    }
                    text += decoder.decode();
                } else {
                    // Bodyless responses and minimal fetch adapters have no readable stream.
                    text = await response.text();
                    if (new env.TextEncoder().encode(text).byteLength > maxBytes) {
                        throw new RangeError('Auxiliary response exceeds byte limit');
                    }
                }
                if (controller.signal.aborted) throw cancellationReason;
                completed = true;
                return { response, text };
            } catch (error) {
                if (!controller.signal.aborted) controller.abort(error);
                throw error;
            } finally {
                if (!completed) cancelBody(reader ?? response?.body);
                if (reader) {
                    try { reader.releaseLock(); } catch {}
                }
            }
        })();
        try {
            // The deadline covers both headers and body, including fetch mocks which ignore abort.
            return await Promise.race([reading, cancelled]);
        } finally {
            env.clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }

    function replaceResponseText(response, originalText, newText) {
        if (newText === originalText) return response;
        // Opaque and bodyless responses cannot be reconstructed with a text body.
        if (response.status === 0 || [204, 205, 304].includes(response.status)) return response;
        const headers = new env.Headers(response.headers);
        for (const header of ['content-length', 'content-encoding', 'etag', 'content-md5', 'digest', 'content-digest', 'repr-digest']) {
            headers.delete(header);
        }
        const replacement = new env.Response(newText, {
            status: response.status,
            statusText: response.statusText,
            headers
        });
        // A constructed Response otherwise loses its fetch URL. HLS clients can use
        // this URL to resolve relative segments; keep the same metadata after clone().
        function preserveMetadata(target) {
            const clone = target.clone.bind(target);
            Object.defineProperties(target, {
                url: { configurable: true, enumerable: true, value: response.url },
                redirected: { configurable: true, enumerable: true, value: response.redirected },
                type: { configurable: true, enumerable: true, value: response.type },
                clone: { configurable: true, writable: true, value: () => preserveMetadata(clone()) }
            });
            return target;
        }
        return preserveMetadata(replacement);
    }

    return { readFetchURL, rewritePlaybackRequest, requestText, replaceResponseText };
}

// Node test exports
module.exports = { createNetworkTools };
