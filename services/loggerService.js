// services/loggerService.js
import { Platform } from 'react-native';
import { realtimeDb } from '../firebase';

// --- MOCK BLOCK START ---
// Safe in-memory mock to prevent AsyncStorage crashes
const MockStorage = {
  _logs: [],
  getItem: async (key) => {
    if (key === 'app_logs') return JSON.stringify(MockStorage._logs);
    return null;
  },
  setItem: async (key, value) => {
    if (key === 'app_logs') MockStorage._logs = JSON.parse(value);
    return Promise.resolve();
  },
};
// --- MOCK BLOCK END ---

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
};

const LOG_COLORS = {
  DEBUG: '\x1b[36m', // Cyan
  INFO: '\x1b[32m',  // Green
  WARN: '\x1b[33m',  // Yellow
  ERROR: '\x1b[31m', // Red
  FATAL: '\x1b[35m', // Magenta
  RESET: '\x1b[0m'
};

class Logger {
  constructor() {
    this.logQueue = [];
    this.isProduction = !__DEV__;
    this.userId = null;
    this.sessionId = this.generateSessionId();
    this.deviceInfo = null;
    this.maxLocalLogs = 1000;
    
    this.initializeLogger();
  }

  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async initializeLogger() {
    try {
      // Use MockStorage
      const storedLogs = await MockStorage.getItem('app_logs');
      if (storedLogs) {
        this.logQueue = JSON.parse(storedLogs);
        if (this.logQueue.length > this.maxLocalLogs) {
          this.logQueue = this.logQueue.slice(-this.maxLocalLogs);
        }
      }
      
      this.deviceInfo = {
        platform: Platform.OS,
        version: Platform.Version,
        model: Platform.constants?.Model || 'Unknown',
      };
    } catch (error) {
      console.error('Failed to initialize logger:', error);
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
    
    const consoleMessage = `${color}[${timestamp}] [${level}] [${component}]${reset} ${message}`;
    
    const logEntry = {
      timestamp,
      level,
      component,
      message,
      data,
      userId: this.userId,
      sessionId: this.sessionId,
      deviceInfo: this.deviceInfo
    };
    
    return { consoleMessage, logEntry };
  }

  async log(level, component, message, data = {}) {
    const { consoleMessage, logEntry } = this.formatMessage(level, component, message, data);
    
    if (!this.isProduction) {
      console.log(consoleMessage);
      if (data && Object.keys(data).length > 0) {
        console.log('Data:', data);
      }
    }
    
    this.logQueue.push(logEntry);
    
    await this.saveLogsLocally();
    
    if (LOG_LEVELS[level] >= LOG_LEVELS.ERROR) {
      await this.sendLogsToServer([logEntry]);
    }
  }

  async saveLogsLocally() {
    try {
      if (this.logQueue.length > this.maxLocalLogs) {
        this.logQueue = this.logQueue.slice(-this.maxLocalLogs);
      }
      // Use MockStorage
      await MockStorage.setItem('app_logs', JSON.stringify(this.logQueue));
    } catch (error) {
      console.error('Failed to save logs locally:', error);
    }
  }

  async sendLogsToServer(logs = null) {
    try {
      const logsToSend = logs || this.logQueue.filter(log => 
        LOG_LEVELS[log.level] >= LOG_LEVELS.WARN
      );
      
      if (logsToSend.length === 0) return;
      
      const batch = {};
      logsToSend.forEach(log => {
        const key = `logs/${log.userId || 'anonymous'}/${log.sessionId}/${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        batch[key] = log;
      });
      
      await realtimeDb.ref().update(batch);
      
      if (!logs) {
        this.logQueue = this.logQueue.filter(log => 
          LOG_LEVELS[log.level] < LOG_LEVELS.WARN
        );
        await this.saveLogsLocally();
      }
    } catch (error) {
      console.error('Failed to send logs to server:', error);
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
      sessionId: this.sessionId,
      userId: this.userId,
      deviceInfo: this.deviceInfo,
      logCount: logs.length,
      logs: logs
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