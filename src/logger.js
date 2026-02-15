const fs = require('fs');
const winston = require('winston');
const config = require('./config');

// Ensure log directory exists
fs.mkdirSync(config.paths.logs, { recursive: true });

const logger = winston.createLogger({
  level: config.nodeEnv === 'development' ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level}]: ${message}${extra}`;
        }),
      ),
    }),
    new winston.transports.File({
      filename: require('path').join(config.paths.logs, 'app.log'),
      maxsize: 5 * 1024 * 1024, // 5 MB per file
      maxFiles: 5,               // keep up to 5 rotated files (~25 MB total)
      tailable: true,            // app.log is always the current file
    }),
  ],
});

module.exports = logger;
