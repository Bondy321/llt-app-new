import { useCallback, useRef } from 'react';

export default function useManifestStatusFeedback(mountedRef, setStatusFeedback) {
  const feedbackTimeoutRef = useRef(null);
  const clearFeedbackTimeout = useCallback(() => {
    if (feedbackTimeoutRef.current) {
      clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = null;
    }
  }, []);
  const showStatusFeedback = useCallback(feedback => {
    if (!mountedRef.current) return;
    clearFeedbackTimeout();
    setStatusFeedback(feedback);
    if (feedback?.autoDismissMs) {
      feedbackTimeoutRef.current = setTimeout(() => {
        setStatusFeedback(current => current === feedback ? null : current);
        feedbackTimeoutRef.current = null;
      }, feedback.autoDismissMs);
    }
  }, [clearFeedbackTimeout, mountedRef, setStatusFeedback]);
  return { clearFeedbackTimeout, showStatusFeedback };
}
