import { createLogger, format, transports } from 'winston';
import { Message } from 'telegraf/typings/core/types/typegram';
import util from 'util';

function safeSerialize(obj: any): any {
    const seen = new WeakSet();
    return JSON.parse(JSON.stringify(obj, (key, value) => {
        if (key === 'logger' || key === 'appDataSource') {
            return '[Circular]';
        }
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
                return '[Circular]';
            }
            seen.add(value);
        }
        return value;
    }));
}

// Define log levels
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Create the logger
const logger = createLogger({
  levels: logLevels,
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    new transports.Console({ level: 'debug' }),
    new transports.File({ filename: 'telegram-bot.log', level: 'info' })
  ],
});

// Helper function to truncate long messages
function truncate(str: string, length: number): string {
  return str.length > length ? str.substring(0, length) + '...' : str;
}

// Logging utility functions
export const logDebug = (method: string, message: string, metadata?: any) => {
  logger.debug(`[${method}] ${message}${metadata ? ' ' + JSON.stringify(metadata) : ''}`);
};

export const logInfo = (method: string, message: string, metadata?: any) => {
  let metadataString = '';
  if (metadata) {
      try {
          metadataString = ' ' + util.inspect(metadata, {
              depth: 2,
              breakLength: Infinity,
              compact: true,
              maxArrayLength: 5
          });
      } catch (error) {
          metadataString = ' Error stringifying metadata';
      }
  }
  logger.info(`[${method}] ${message}${metadataString}`);
};

export const logWarn = (method: string, message: string, metadata?: any) => {
  logger.warn(`[${method}] ${message}${metadata ? ' ' + JSON.stringify(metadata) : ''}`);
};

export const logError = (method: string, message: string, error: Error | unknown, context?: Record<string, unknown>) => {
    let errorDetails;
    if (error instanceof Error) {
        errorDetails = {
            name: error.name,
            message: error.message,
            stack: error.stack
        };
    } else if (typeof error === 'object' && error !== null) {
        errorDetails = {
            name: 'UnknownError',
            message: JSON.stringify(error),
            raw: error
        };
    } else {
        errorDetails = {
            name: 'UnknownError',
            message: String(error)
        };
    }

    const logEntry = {
        method,
        message,
        error: errorDetails,
        context: context ? safeSerialize(context) : undefined
    };
    
    console.error(JSON.stringify(logEntry, null, 2));
};

export const logMessageProcessingStart = (method: string, sessionId: string, messageType: string, message: Message) => {
  let contentPreview = 'N/A';
  if ('text' in message) {
    contentPreview = truncate(message.text, 20);
  } else if ('caption' in message && message.caption) {
    contentPreview = truncate(message.caption, 20);
  } else if ('new_chat_members' in message) {
    contentPreview = 'New chat member(s)';
  } else if ('left_chat_member' in message) {
    contentPreview = 'Left chat member';
  } // Add more conditions for other message types as needed

  logInfo(method, `Started processing message. SessionID: ${sessionId}, MessageType: ${messageType}, ContentPreview: "${contentPreview}"`);
};

export const logChatHistory = (method: string, sessionId: string, historyLength: number) => {
  logDebug(method, `Retrieved chat history for session ${sessionId}. Length: ${historyLength} messages`);
};

export const logApiRequest = (method: string, model: string, messageCount: number) => {
  logDebug(method, `Sending request to API. Model: ${model}, MessageCount: ${messageCount}`);
};