const fs = require('fs');
const winston = require('winston');
const config = require('./config');

// Ensure log directory exists
fs.mkdirSync(config.paths.logs, { recursive: true });

// Shared human-readable format: "2026-02-15T03:12:45Z [info]: message  key=value"
const readableFormat = winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
  // Strip ANSI colour codes for the file transport (no-op if already plain)
  const plain = typeof level === 'string' ? level.replace(/\u001b\[\d+m/g, '') : level;
  let line = `${timestamp} [${plain}]: ${stack || message}`;
  // Append metadata as key=value pairs (skip internal symbol keys)
  const keys = Object.keys(meta);
  if (keys.length) {
    const pairs = keys.map((k) => `${k}=${typeof meta[k] === 'object' ? JSON.stringify(meta[k]) : meta[k]}`);
    line += '  ' + pairs.join(' ');
  }
  return line;
});

const logger = winston.createLogger({
  level: config.nodeEnv === 'development' ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }),
    winston.format.errors({ stack: true }),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        readableFormat,
      ),
    }),
    new winston.transports.File({
      filename: require('path').join(config.paths.logs, 'app.log'),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
      format: readableFormat,
    }),
  ],
});

module.exports = logger;
