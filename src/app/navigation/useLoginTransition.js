'use strict';

import { useCallback, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';

export default function useLoginTransition() {
  const [loginTransition, setLoginTransition] = useState(null);
  const timerRef = useRef(null);
  const animationRef = useRef(null);
  const loginProgress = useRef(new Animated.Value(0)).current;

  const clearLoginTransitionArtifacts = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (animationRef.current) {
      animationRef.current.stop();
      animationRef.current = null;
    }
  }, []);

  const resetLoginTransition = useCallback(() => {
    clearLoginTransitionArtifacts();
    setLoginTransition(null);
    loginProgress.setValue(0);
  }, [clearLoginTransitionArtifacts, loginProgress]);

  const startLoginTransition = useCallback(({ targetScreen, durationMs }) => {
    clearLoginTransitionArtifacts();
    loginProgress.setValue(0);
    setLoginTransition({ targetScreen, message: 'Tour synced - entering dashboard', durationMs });
    animationRef.current = Animated.timing(loginProgress, {
      toValue: 1,
      duration: durationMs,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    animationRef.current.start();
    timerRef.current = setTimeout(() => {
      clearLoginTransitionArtifacts();
      setLoginTransition(null);
      loginProgress.setValue(0);
    }, durationMs);
  }, [clearLoginTransitionArtifacts, loginProgress]);

  return {
    clearLoginTransitionArtifacts,
    loginProgress,
    loginTransition,
    resetLoginTransition,
    startLoginTransition,
  };
}
