/**
 * Wraps chrome.runtime.sendMessage in a Promise, normalizing both
 * chrome.runtime.lastError and an in-band `{ error }` response into a
 * rejected promise. Used by every extension page that talks to the
 * background service worker — the popup, the options page, and any page
 * opened programmatically via chrome.windows.create (e.g. create-secret) —
 * this contract isn't popup-specific.
 */
export function sendMessage<T>(message: { type: string; payload?: unknown }): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T & { error?: string }) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}
