// src/utils/modelUtility.ts

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { BaseMessage, AIMessage } from '@langchain/core/messages';
import { v4 as uuidv4 } from 'uuid';

interface ModelInvokeOptions {
  initialTimeout?: number;
  maxTimeout?: number;
  retries?: number;
  skipUtilityModel?: boolean; // Option to skip utility model
}

interface PendingRequest {
  controller: AbortController;
  timeoutId: NodeJS.Timeout;
}

const pendingRequests = new Map<string, PendingRequest>();

// Set the streaming settle timeout to 5000ms (adjust if needed)
const STREAM_SETTLE_MS = 5000;

/**
 * Aggregates all chunks from an async iterable.
 * Instead of relying solely on the iterator’s end event we poll for the next chunk.
 * If no token is received within `settleMs`, we assume the stream is finished.
 *
 * @param iterable An async iterable producing the streaming chunks.
 * @param settleMs The amount of time (in ms) to wait for a new chunk before finishing.
 */
async function aggregateAsyncIterable(
  iterable: AsyncIterable<any>,
  settleMs = STREAM_SETTLE_MS
): Promise<string> {
  let aggregated = '';
  const iterator = iterable[Symbol.asyncIterator]();

  while (true) {
    // Start the next() call.
    const nextPromise = iterator.next();
    // Also create a timeout promise.
    const timeoutPromise = new Promise<null>(resolve =>
      setTimeout(() => resolve(null), settleMs)
    );
    // Wait for whichever comes first.
    const result = await Promise.race([nextPromise, timeoutPromise]);
    if (result === null) {
      // No token arrived within settleMs; assume the stream is done.
      break;
    }
    if (result.done) {
      break;
    }
    const chunk = result.value;
    if (chunk && typeof chunk === 'object' && 'content' in chunk) {
      aggregated += chunk.content;
    } else {
      aggregated += chunk.toString();
    }
  }
  return aggregated;
}

/**
 * Calls the model’s invoke() method and, if a streaming response is returned as an async iterable,
 * accumulates its chunks until complete.
 *
 * For streaming responses the aggregator (with an extended settle timeout) is used.
 */
async function invokeAndAggregate(
  model: BaseChatModel,
  messages: BaseMessage[],
  signal: AbortSignal,
  nonStreamingTimeout: number
): Promise<any> {
  const result = await model.invoke(messages, { signal });
  // Cast to any so we can check for the async iterator.
  const anyResult = result as any;
  if (anyResult && typeof anyResult[Symbol.asyncIterator] === 'function') {
    // If the response is streaming, wait for tokens until there’s a pause longer than STREAM_SETTLE_MS.
    const aggregated = await aggregateAsyncIterable(anyResult, STREAM_SETTLE_MS);
    return { content: aggregated };
  }
  // Otherwise, assume the response is a complete non-streaming result.
  return result;
}

// Type guard for response validation.
const isValidResponse = (response: any): response is { content: string; additional_kwargs?: Record<string, any> } => {
  return response && typeof response === 'object' && 'content' in response;
};

// Convert response to an AIMessage.
const toAIMessage = (response: any): AIMessage => {
  if (response instanceof AIMessage) {
    return response;
  }
  if (isValidResponse(response)) {
    return new AIMessage(response.content, response.additional_kwargs);
  }
  throw new Error(`Invalid response format: ${JSON.stringify(response)}`);
};

// Patch a model so that if it is LM‑Studio, token counting is skipped.
const patchLocalModel = (model: any) => {
  if (model.apiKey === 'lm-studio' || model.baseURL?.includes('127.0.0.1')) {
    model.getNumTokensFromMessages = async () => 0;
    model.getNumTokens = async () => 0;
  }
};

async function invokeModelWithFallback(
  utilityModel: BaseChatModel,   // Small, fast model for simple tasks
  primaryModel: BaseChatModel,     // Main model for most tasks
  fallbackModel: BaseChatModel,    // Fallback model for reliability
  messages: BaseMessage[],
  options: ModelInvokeOptions = {}
): Promise<AIMessage> {
  const { 
    initialTimeout = 60000,    // Default timeout for non-streaming utility model
    maxTimeout = 120000,       // Maximum timeout for primary/fallback non-streaming responses
    retries = 2,
    skipUtilityModel = false   // Option to bypass the utility model
  } = options;

  // Patch models if they use LM‑Studio.
  patchLocalModel(utilityModel);
  patchLocalModel(primaryModel);
  patchLocalModel(fallbackModel);

  let attempts = 0;
  let currentTimeout = initialTimeout;
  const requestId = uuidv4();

  // Try the utility model first unless skipped.
  if (!skipUtilityModel) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), initialTimeout);
      pendingRequests.set(requestId, { controller, timeoutId });

      try {
        const response = await Promise.race([
          invokeAndAggregate(utilityModel, messages, controller.signal, initialTimeout),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Utility model timeout after ${initialTimeout}ms`)), initialTimeout)
          ),
        ]);
        clearPendingRequest(requestId);
        return toAIMessage(response);
      } catch (error) {
        clearPendingRequest(requestId);
        console.warn('Utility model failed or timed out, falling back to primary model');
        // Fall through to primary model.
      }
    } catch (error) {
      console.warn('Error with utility model, proceeding to primary model:', error);
    }
  }

  // Now try the primary model.
  while (attempts <= retries) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), currentTimeout);
      pendingRequests.set(requestId, { controller, timeoutId });

      try {
        const response = await Promise.race([
          invokeAndAggregate(primaryModel, messages, controller.signal, currentTimeout),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Primary model timeout after ${currentTimeout}ms`)), currentTimeout)
          ),
        ]);
        clearPendingRequest(requestId);
        return toAIMessage(response);
      } catch (error: any) {
        clearPendingRequest(requestId);
        if (error.name === 'AbortError' || error.message.includes('timeout')) {
          console.warn(`Primary model timed out after ${currentTimeout}ms. Attempt ${attempts + 1}/${retries + 1}`);
          if (attempts === retries) {
            console.warn('Switching to fallback model');
            const fallbackResponse = await invokeWithTimeout(fallbackModel, messages, maxTimeout);
            return toAIMessage(fallbackResponse);
          }
          // Increase the timeout for the next attempt.
          currentTimeout = Math.min(currentTimeout * 2, maxTimeout);
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error(`Error invoking model. Attempt ${attempts + 1}/${retries + 1}`, error);
      if (attempts === retries) {
        throw error;
      }
    }
    attempts++;
  }

  throw new Error('Failed to get a valid response after all attempts');
}

/**
 * Invoke a model with a given timeout and use invokeAndAggregate to ensure that
 * any streaming response is fully accumulated.
 */
async function invokeWithTimeout(model: BaseChatModel, messages: BaseMessage[], timeout: number): Promise<AIMessage> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await invokeAndAggregate(model, messages, controller.signal, timeout);
    if (response instanceof AIMessage) {
      return response;
    } else {
      return new AIMessage(response.content, response.additional_kwargs);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function clearPendingRequest(requestId: string) {
  const request = pendingRequests.get(requestId);
  if (request) {
    clearTimeout(request.timeoutId);
    pendingRequests.delete(requestId);
  }
}

function cancelAllPendingRequests() {
  for (const [requestId, request] of pendingRequests) {
    request.controller.abort();
    clearTimeout(request.timeoutId);
    pendingRequests.delete(requestId);
  }
}

export { invokeModelWithFallback, cancelAllPendingRequests };
