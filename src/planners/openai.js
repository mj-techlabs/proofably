import OpenAI from 'openai';
import { DEFAULT_MODEL, MAX_RESPONSE_BYTES, PlannerError, plannerBudget, buildRequest, preflight,
  usageRecord, validateCases, digest } from './core.js';
import { stringifyJson } from '../json-data.mjs';

// Bound the HTTP response before the SDK buffers/parses it; includes metadata.
export function limitedFetch(fetchImpl = globalThis.fetch, maximum = 131072) {
  return async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream({ async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) return controller.close();
        bytes += chunk.value.byteLength;
        if (bytes > maximum) {
          await reader.cancel();
          controller.error(new PlannerError('http-response-too-large'));
        } else controller.enqueue(chunk.value);
      } catch (error) { controller.error(error); }
    }, cancel(reason) { return reader.cancel(reason); } });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export function openAIPlanner({ model = process.env.PROOFABLY_MODEL || DEFAULT_MODEL, client } = {}) {
  return { async proposeExperiments(context, options = {}) {
    const budget = plannerBudget(options);
    const request = buildRequest(context, budget, model);
    const estimate = preflight(request, budget);
    const metadata = { provider: 'openai', model, requestCount: 0, promptVersion: 1,
      requestSha256: digest(stringifyJson(request)), preflight: estimate, usage: null };
    if (!client && !process.env.OPENAI_API_KEY) throw new PlannerError('missing-api-key', metadata);
    let api = client;
    if (!api) {
      api = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: 'https://api.openai.com/v1',
        maxRetries: 0, timeout: budget.timeoutMs, logLevel: 'off', fetch: limitedFetch() });
    }
    const controller = new AbortController();
    let timer;
    let response;
    metadata.requestCount = 1;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new PlannerError('request-timeout')); }, budget.timeoutMs);
      });
      response = await Promise.race([api.responses.create(request, { maxRetries: 0,
        timeout: budget.timeoutMs, signal: controller.signal }), timeout]);
    } catch (error) {
      // Never expose SDK messages, headers, credentials or raw request bodies.
      throw new PlannerError(error?.code === 'request-timeout' || error?.name === 'APIConnectionTimeoutError' ||
        error?.name === 'AbortError' ? 'request-timeout' : 'api-request-failed', metadata);
    } finally { clearTimeout(timer); }
    const expectedModel = response?.model === undefined || (typeof response.model === 'string' &&
      (response.model === model || response.model.startsWith(model + '-')));
    metadata.usage = usageRecord(response?.usage, expectedModel ? estimate.pricing : null);
    if (!expectedModel) throw new PlannerError('unexpected-model', metadata);
    if (typeof response?.model === 'string' && response.model.length <= 128) metadata.responseModel = response.model;
    if (typeof response?.id === 'string' && /^resp_[a-zA-Z0-9_-]{1,128}$/.test(response.id)) metadata.responseId = response.id;
    if (response?.status !== 'completed') throw new PlannerError('incomplete-response', metadata);
    if (!Array.isArray(response.output) || response.output.length > 16) throw new PlannerError('invalid-response', metadata);
    let text = '';
    for (const item of response.output) {
      if (item.type === 'reasoning') continue;
      if (item.type !== 'message' || item.status !== 'completed' || item.role !== 'assistant' || !Array.isArray(item.content)) {
        throw new PlannerError('unexpected-response-item', metadata);
      }
      for (const part of item.content) {
        if (part.type === 'refusal') throw new PlannerError('refusal', metadata);
        if (part.type !== 'output_text' || typeof part.text !== 'string') throw new PlannerError('invalid-response', metadata);
        text += part.text;
        if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new PlannerError('response-too-large', metadata);
      }
    }
    if (metadata.usage && (metadata.usage.inputTokens > budget.maxInputTokens || metadata.usage.outputTokens > budget.maxOutputTokens ||
      metadata.usage.totalTokens > budget.maxTotalTokens || metadata.usage.estimatedCostUSD > budget.maxCostUSD)) {
      throw new PlannerError('reported-usage-exceeds-budget', metadata);
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new PlannerError('malformed-json', metadata); }
    try { return { cases: validateCases(data, context, budget), provenance: metadata }; }
    catch (error) { throw new PlannerError(error.code || 'invalid-response', metadata); }
  } };
}
