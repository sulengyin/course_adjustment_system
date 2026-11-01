/**
 * 结构化日志：只接受事件码与白名单字段。
 *
 * 为什么这么严：日志会被集中收集、长期保存，且查看范围通常比业务数据更宽。
 * 教师请假原因、手机号、口令、会话 token 一旦写进日志，等于绕过了权限矩阵里
 * "他人私人理由无人可见"这一条。所以这里不做"过滤敏感词"，而是**默认丢弃未登记字段**。
 */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/** 允许写入日志的字段。新增字段必须先问：它会不会包含个人材料？ */
export const ALLOWED_LOG_KEYS: readonly string[] = Object.freeze([
  'actor',
  'actingRole',
  'method',
  'path',
  'status',
  'code',
  'objectType',
  'objectId',
  'count',
  'durationMs',
  'address',
  'port',
  'tls',
]);

const EVENT_RE = /^[A-Z][A-Z0-9_]{2,48}$/;
const PHONE_RE = /\b1[3-9]\d{9}\b/g;

export interface LogRecord {
  readonly at: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

export type LogSink = (line: string) => void;

export function redactFields(input: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_LOG_KEYS.includes(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      // 即使字段合法，也不允许把手机号这类标识写进去
      out[key] = value.replace(PHONE_RE, '[REDACTED]').slice(0, 200);
    }
  }
  return out;
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export function createLogger(options: { sink?: LogSink; now?: () => string } = {}): Logger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date().toISOString());

  // 不依赖 `this`：logger 常被解构传递（`const { info } = logger`），
  // 用 this.log 会在那时抛 TypeError，把日志变成故障源。
  function write(level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (!EVENT_RE.test(event)) {
      // 事件码不合法说明调用方在拼字符串；宁可丢弃，也不把未知内容写出去。
      return;
    }
    const record: LogRecord = { at: now(), level, event, fields: redactFields(fields) };
    sink(JSON.stringify(record));
  }

  return {
    log: write,
    info(event, fields) {
      write('INFO', event, fields);
    },
    warn(event, fields) {
      write('WARN', event, fields);
    },
    error(event, fields) {
      write('ERROR', event, fields);
    },
  };
}

/** 测试与审计用的默认实现：不输出，只保留内存记录。 */
export function createMemoryLogger(now?: () => string): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line), now });
  return Object.assign(logger, { lines });
}
