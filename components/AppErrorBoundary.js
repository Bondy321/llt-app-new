import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import logger from '../services/loggerService';
import { COLORS, RADIUS, SPACING } from '../theme';

/**
 * Last-resort recovery surface for render and lifecycle failures.
 *
 * Event-handler and async failures are handled by their owning flows; React
 * error boundaries specifically keep a bad screen render from leaving a blank
 * native view with no route back into the app.
 */
export default class AppErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    logger.error('AppErrorBoundary', 'Unhandled render failure', {
      error: error?.message || 'Unknown render error',
      componentStack: info?.componentStack || null,
    });
  }

  componentDidUpdate(previousProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  handleReset = () => {
    const { onReset } = this.props;
    this.setState({ error: null }, () => {
      if (typeof onReset === 'function') onReset();
    });
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <View
        style={styles.container}
        accessibilityRole="alert"
        accessibilityLabel="The app encountered an unexpected problem"
      >
        <View style={styles.iconBadge} accessible={false}>
          <Text style={styles.icon}>!</Text>
        </View>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.message}>
          Your saved tour details are still on this device. Try reopening the app screen.
        </Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Try reopening the app"
          onPress={this.handleReset}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xxxl,
    backgroundColor: COLORS.background,
  },
  iconBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.lg,
    backgroundColor: COLORS.errorLight,
    borderWidth: 1,
    borderColor: COLORS.error,
  },
  icon: {
    color: COLORS.error,
    fontSize: 32,
    lineHeight: 36,
    fontWeight: '800',
  },
  title: {
    color: COLORS.textPrimary,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '800',
    textAlign: 'center',
  },
  message: {
    maxWidth: 420,
    marginTop: SPACING.sm,
    color: COLORS.textSecondary,
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center',
  },
  button: {
    minHeight: 48,
    minWidth: 160,
    marginTop: SPACING.xxl,
    paddingHorizontal: SPACING.xxl,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.primary,
  },
  buttonText: {
    color: COLORS.textInverse,
    fontSize: 16,
    fontWeight: '700',
  },
});
