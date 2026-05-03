/**
 * Logger
 * ======
 * Structured console + file logging using winston.
 */

const { createLogger, format, transports } = require("winston");
const path = require("path");

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack }) => {
      const base = `[${timestamp}] ${level.toUpperCase().padEnd(5)}: ${message}`;
      return stack ? `${base}\n${stack}` : base;
    })
  ),
  transports: [
    new transports.Console({
      format: format.printf(({ timestamp, level, message, stack }) => {
        const LEVEL_COLORS = { error: "\x1b[31m", warn: "\x1b[33m", info: "\x1b[36m", debug: "\x1b[90m" };
        const c = LEVEL_COLORS[level] || "";
        const base = `[${timestamp}] ${c}${level.toUpperCase().padEnd(5)}\x1b[0m: ${message}`;
        return stack ? `${base}\n${stack}` : base;
      }),
    }),
    new transports.File({
      filename: path.join(__dirname, "../logs/agent.log"),
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 3,
    }),
    new transports.File({
      filename: path.join(__dirname, "../logs/errors.log"),
      level: "error",
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 3,
    }),
  ],
});

module.exports = logger;