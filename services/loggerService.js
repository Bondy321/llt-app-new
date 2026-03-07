// services/loggerService.js
import { Platform } from 'react-native';
import { realtimeDb } from '../firebase';
import { createPersistenceProvider } from './persistenceProvider';

// Centralized persistence with SecureStore/AsyncStorage fallback for durable logs.
const logStorage = createPersistenceProvider({ namespace: 'LLT_LOGS' });

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
};

const LOG_COLORS = {
  DEBUG: '\x1b[36m',
  INFO: '\x1b[32m',
  WARN: '\x1b[33m',
  ERROR: '\x1b[31m',
  FATAL: '\x1b[35m',
  RESET: '\x1b[0m'
};

const SENSITIVE_KEYS = new Set([
  'bookingref',
  'reference',
  'drivercode',
  'authuid',
  'token',
  'pushtoken',
  'uid',
  'userid',
  'sessionid',
  'authorization',
  'password',
]);

const hasSensitiveKeyFragment = (key = '') => {
  const normalizedKey = String(key || '').toLowerCase();
  if (SENSITIVE_KEYS.has(normalizedKey)) return true;
  return ['token', 'secret', 'session', 'auth', 'booking', 'reference', 'drivercode'].some((fragment) => normalizedKey.includes(fragment));
};

export const maskIdentifier = (value) => {
  if (value === null || value === undefined) return value;
  const asString = String(value).trim();
  if (!asString) return asString;
  if (asString.length <= 4) return `${asString[0] || ''}***`;
  return `${asString.slice(0, 2)}***${asString.slice(-2)}`;
};

const redactValueForKey = (key, value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return maskIdentifier(value);
  }
  return '[REDACTED]';
};

export const redactSensitiveData = (input, contextKey = '', seen = new WeakSet()) => {
  if (input === null || input === undefined) return input;

  if (typeof input !== 'object') {
    if (hasSensitiveKeyFragment(contextKey)) {
      return redactValueForKey(contextKey, input);
    }
    return input;
  }

  if (seen.has(input)) return '[Circular]';
  seen.add(input);

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveData(item, contextKey, seen));
  }

  const output = {};
  Object.entries(input).forEach(([key, value]) => {
    if (hasSensitiveKeyFragment(key)) {
      output[key] = redactValueForKey(key, value);
      return;
    }

    output[key] = redactSensitiveData(value, key, seen);
  });

  return output;
};

class Logger {
  constructor() {
    this.logQueue = [];
    this.isProduction = !__DEV__;
    this.userId = null;
    this.sessionId = this.generateSessionId();
    this.deviceInfo = null;
    this.maxLocalLogs = 1000;
    this.maxServerBatchSize = 100;
    this.flushDebounceMs = 750;
    this.maxRetryAttempts = 4;
    this.baseRetryDelayMs = 400;
    this.storageMode = logStorage.mode;
    this.flushTimer = null;
    this.persistTimer = null;
    this.isFlushing = false;

    this.initializeLogger();
  }

  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async initializeLogger() {
    try {
      const storedLogs = await logStorage.getItemAsync('app_logs');
      if (storedLogs) {
        this.logQueue = JSON.parse(storedLogs);
        if (this.logQueue.length > this.maxLocalLogs) {
          this.logQueue = this.logQueue.slice(-this.maxLocalLogs);
        }
      }

      if (!this.isProduction) {
        console.log(`[Logger] Initialized with storage mode: ${this.storageMode}`);
        console.log(`[Logger] Restored ${this.logQueue.length} persisted logs`);
      }

      this.deviceInfo = {
        platform: Platform.OS,
        version: Platform.Version,
        model: Platform.constants?.Model || 'Unknown',
      };
    } catch (error) {
      if (!this.isProduction) {
        console.error('Failed to initialize logger:', redactSensitiveData({ error: error?.message || 'Unknown error' }));
      }
    }
  }

  setUserId(userId) {
    this.userId = userId;
    this.log('INFO', 'Logger', 'User ID set', { userId });
  }

  formatMessage(level, component, message, data) {
    const timestamp = new Date().toISOString();
    const color = LOG_COLORS[level];
    const reset = LOG_COLORS.RESET;
    const sanitizedData = redactSensitiveData(data || {});

    const consoleMessage = `${color}[${timestamp}] [${level}] [${component}]${reset} ${message}`;

    const logEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      timestamp,
      level,
      component,
      message,
      data: sanitizedData,
      userId: maskIdentifier(this.userId),
      sessionId: maskIdentifier(this.sessionId),
      deviceInfo: this.deviceInfo,
      routeUserId: this.userId || 'anonymous',
      routeSessionId: this.sessionId || 'session_unknown'
    };

    return { consoleMessage, logEntry, sanitizedData };
  }

  async log(level, component, message, data = {}) {
    const { consoleMessage, logEntry, sanitizedData } = this.formatMessage(level, component, message, data);

    if (!this.isProduction) {
      console.log(consoleMessage);
      if (sanitizedData && Object.keys(sanitizedData).length > 0) {
        console.log('Data:', sanitizedData);
      }
    }

    this.enqueueLog(logEntry);

    if (LOG_LEVELS[level] >= LOG_LEVELS.ERROR) {
      this.scheduleServerFlush(true);
    } else if (LOG_LEVELS[level] >= LOG_LEVELS.WARN) {
      this.scheduleServerFlush(false);
    }
  }

  enqueueLog(logEntry) {
    this.logQueue.push(logEntry);
    if (this.logQueue.length > this.maxLocalLogs) {
      this.logQueue = this.logQueue.slice(-this.maxLocalLogs);
    }

    this.scheduleLocalPersist();
  }

  scheduleLocalPersist() {
    if (this.persistTimer) return;

    this.persistTimer = setTimeout(async () => {
      this.persistTimer = null;
      await this.saveLogsLocally();
    }, this.flushDebounceMs);
  }

  scheduleServerFlush(priority = false) {
    if (this.flushTimer) {
      if (priority) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      } else {
        return;
      }
    }

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      await this.flushServerQueue();
    }, priority ? 0 : this.flushDebounceMs);
  }

  async saveLogsLocally() {
    try {
      if (this.logQueue.length > this.maxLocalLogs) {
        this.logQueue = this.logQueue.slice(-this.maxLocalLogs);
      }
      await logStorage.setItemAsync('app_logs', JSON.stringify(this.logQueue));
    } catch (error) {
      if (!this.isProduction) {
        console.error(`Failed to save logs locally via ${this.storageMode}:`, redactSensitiveData({ error: error?.message || 'Unknown error' }));
      }
    }
  }

  async wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  buildServerPayload(log) {
    return redactSensitiveData({
      timestamp: log.timestamp,
      level: log.level,
      component: log.component,
      message: log.message,
      data: log.data,
      userId: log.userId,
      sessionId: log.sessionId,
      deviceInfo: log.deviceInfo
    });
  }

  async updateBatchWithRetry(batch, attempt = 1) {
    try {
      await realtimeDb.ref().update(batch);
    } catch (error) {
      if (attempt >= this.maxRetryAttempts) {
        throw error;
      }

      const backoffMs = this.baseRetryDelayMs * (2 ** (attempt - 1));
      await this.wait(backoffMs);
      return this.updateBatchWithRetry(batch, attempt + 1);
    }
  }

  async flushServerQueue() {
    if (this.isFlushing) return;

    this.isFlushing = true;
    try {
      const warnAndAbove = this.logQueue.filter((log) => LOG_LEVELS[log.level] >= LOG_LEVELS.WARN);
      if (warnAndAbove.length === 0) return;

      const sentLogIds = new Set();
      for (let i = 0; i < warnAndAbove.length; i += this.maxServerBatchSize) {
        const chunk = warnAndAbove.slice(i, i + this.maxServerBatchSize);
        await this.sendLogsToServer(chunk);
        chunk.forEach((log) => sentLogIds.add(log.id));
      }

      this.logQueue = this.logQueue.filter((log) => !sentLogIds.has(log.id));
      await this.saveLogsLocally();
    } catch (error) {
      if (!this.isProduction) {
        console.error('Failed to flush logs to server:', redactSensitiveData({ error: error?.message || 'Unknown error' }));
      }
    } finally {
      this.isFlushing = false;
    }
  }

  async sendLogsToServer(logs = null) {
    try {
      if (!logs) {
        await this.flushServerQueue();
        return;
      }

      const logsToSend = logs.filter((log) => LOG_LEVELS[log.level] >= LOG_LEVELS.WARN);

      if (logsToSend.length === 0) return;

      for (let i = 0; i < logsToSend.length; i += this.maxServerBatchSize) {
        const chunk = logsToSend.slice(i, i + this.maxServerBatchSize);
        const batch = {};
        chunk.forEach((log) => {
          const userKey = log.routeUserId || 'anonymous';
          const sessionKey = log.routeSessionId || 'session_unknown';
          const key = `logs/${userKey}/${sessionKey}/${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
          batch[key] = this.buildServerPayload(log);
        });

        await this.updateBatchWithRetry(batch);
      }
    } catch (error) {
      if (!this.isProduction) {
        console.error('Failed to send logs to server:', redactSensitiveData({ error: error?.message || 'Unknown error' }));
      }
    }
  }

  debug(component, message, data) { return this.log('DEBUG', component, message, data); }
  info(component, message, data) { return this.log('INFO', component, message, data); }
  warn(component, message, data) { return this.log('WARN', component, message, data); }
  error(component, message, data) { return this.log('ERROR', component, message, data); }
  fatal(component, message, data) { return this.log('FATAL', component, message, data); }

  async trackEvent(eventName, eventData = {}) {
    return this.info('Analytics', eventName, {
      ...eventData,
      timestamp: new Date().toISOString()
    });
  }

  async trackScreen(screenName, params = {}) {
    return this.info('Navigation', `Screen viewed: ${screenName}`, params);
  }

  async trackAPI(endpoint, method, status, duration) {
    const level = status >= 400 ? 'ERROR' : 'INFO';
    return this.log(level, 'API', `${method} ${endpoint}`, {
      status,
      duration,
      endpoint,
      method
    });
  }

  async getStoredLogs(level = null) {
    if (!level) return this.logQueue;
    return this.logQueue.filter(log => LOG_LEVELS[log.level] >= LOG_LEVELS[level]);
  }

  async clearOldLogs(daysToKeep = 7) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    this.logQueue = this.logQueue.filter(log => new Date(log.timestamp) > cutoffDate);
    await this.saveLogsLocally();
  }

  async exportLogs() {
    const logs = await this.getStoredLogs();
    return {
      sessionId: maskIdentifier(this.sessionId),
      userId: maskIdentifier(this.userId),
      deviceInfo: this.deviceInfo,
      logCount: logs.length,
      logs
    };
  }
}

const logger = new Logger();

export const logErrorBoundary = (error, errorInfo) => {
  logger.fatal('ErrorBoundary', 'Unhandled error caught', {
    error: error.toString(),
    stack: error.stack,
    componentStack: errorInfo.componentStack
  });
};

if (!__DEV__) {
  const originalHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    logger.fatal('GlobalError', `${isFatal ? 'Fatal' : 'Non-fatal'} error`, {
      error: error.toString(),
      stack: error.stack,
      isFatal
    });
    originalHandler(error, isFatal);
  });
}

export default logger;
