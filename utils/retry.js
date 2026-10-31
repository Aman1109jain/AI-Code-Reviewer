async function withRetry(fn, maxRetries = 3, delayMs = 3000) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable =
        error.message.includes('503') ||
        error.message.includes('UNAVAILABLE') ||
        error.message.includes('overloaded') ||
        error.message.includes('socket disconnected') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('ETIMEDOUT');

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      console.log(`Attempt ${attempt} failed (${error.message.slice(0, 80)}...). Retrying in ${delayMs / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

module.exports = { withRetry };