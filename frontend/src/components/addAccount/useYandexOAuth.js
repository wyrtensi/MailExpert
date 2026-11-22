import { useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api.js';
import { mailboxBrowserOAuthErrorKey } from '../../utils/mailboxBrowserOAuth.js';

const VERIFICATION_URIS = new Set(['https://ya.ru/device', 'https://oauth.yandex.ru/device']);
const DEFAULT_ERROR = 'admin.integrations.yandex.errorAuthenticationFailed';
const deviceErrorKey = (code) => code === 'invalid_state'
  ? 'admin.integrations.yandex.errorExpired' : mailboxBrowserOAuthErrorKey('yandex', code);
const MAX_POLL_RETRIES = 2;
const retryablePollError = (error) => error instanceof TypeError || error instanceof SyntaxError
  || (!error?.code && [502, 503, 504].includes(error?.status));
const cancelFlow = (flowId) => api.cancelYandexOAuth(flowId).catch(() => {});

export default function useYandexOAuth(signal) {
  const active = useRef(null);
  const [state, setState] = useState(null);

  useEffect(() => {
    const stop = () => active.current?.stop();
    signal?.addEventListener('abort', stop);
    return () => {
      signal?.removeEventListener('abort', stop);
      stop();
    };
  }, [signal]);

  const start = async (target, onSuccess) => {
    if (active.current || signal?.aborted) return;
    const controller = new AbortController();
    const attempt = { stop };
    let flowId;
    let timer;
    let pollRetries = 0;

    function stop({ cancel = true } = {}) {
      if (active.current !== attempt) return;
      active.current = null;
      clearTimeout(timer);
      controller.abort();
      if (cancel && flowId) cancelFlow(flowId);
    }

    function fail(errorKey, options) {
      if (controller.signal.aborted) return;
      stop(options);
      setState({ errorKey });
    }

    function schedulePoll(interval) {
      timer = setTimeout(async () => {
        try {
          const response = await api.pollYandexOAuth(flowId, controller.signal);
          if (controller.signal.aborted) return;
          pollRetries = 0;
          if (response.status === 'pending') {
            const nextInterval = Number.isFinite(response.interval) ? Math.max(interval, response.interval) : interval;
            schedulePoll(nextInterval);
          } else if (response.status === 'success') {
            stop({ cancel: false });
            setState(null);
            onSuccess(response.result);
          } else if (response.status === 'declined') {
            fail('admin.integrations.yandex.errorDeclined');
          } else if (response.status === 'expired') {
            fail('admin.integrations.yandex.errorExpired');
          } else {
            fail(DEFAULT_ERROR);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          const retryable = retryablePollError(error);
          if (retryable && pollRetries < MAX_POLL_RETRIES) {
            pollRetries++;
            schedulePoll(interval);
            return;
          }
          // The server may have committed already. Preserve its cached result on network failure.
          fail(deviceErrorKey(error?.code), { cancel: !retryable });
        }
      }, interval * 1000);
    }

    active.current = attempt;
    setState({ starting: true });
    try {
      // Retain the response so an attempt closed during the start call can still cancel by ID.
      const flow = await api.startYandexOAuth(target);
      flowId = flow.flowId;
      if (controller.signal.aborted) {
        if (flowId) cancelFlow(flowId);
        return;
      }
      if (!flowId || !flow.userCode || !VERIFICATION_URIS.has(flow.verificationUri)
        || !Number.isFinite(flow.interval) || flow.interval <= 0
        || !Number.isFinite(flow.expiresIn) || flow.expiresIn <= 0) {
        fail(DEFAULT_ERROR);
        return;
      }
      setState({ flow });
      // The backend owns expiry. A poll that already exchanged the device code can
      // still be verifying the mailbox when the advertised lifetime ends.
      schedulePoll(flow.interval);
    } catch (error) {
      fail(deviceErrorKey(error?.code));
    }
  };

  return {
    ...state,
    start,
    cancel() {
      active.current?.stop();
      setState(null);
    },
  };
}
