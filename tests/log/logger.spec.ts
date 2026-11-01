import { describe, expect, it } from 'vitest';
import { createLogger, createMemoryLogger, redactFields } from '../../src/log/logger.js';

describe('日志脱敏', () => {
  it('未登记字段一律丢弃：请假理由、口令、手机号都写不进去', () => {
    const fields = redactFields({
      reason: '孩子发烧需要照顾',
      password: 'Passw0rd!2026x',
      phone: '13800138000',
      token: 'abc.def.ghi',
      actor: 'U-1',
      status: 200,
    });
    expect(fields).toEqual({ actor: 'U-1', status: 200 });
  });

  it('合法字段里的手机号也会被替换', () => {
    const fields = redactFields({ actor: '13800138000', objectId: 'T-1' });
    expect(fields.actor).toBe('[REDACTED]');
    expect(fields.objectId).toBe('T-1');
  });

  it('事件码不合法时整条丢弃，避免把未知内容拼进日志', () => {
    const sink: string[] = [];
    const logger = createLogger({ sink: (line) => sink.push(line), now: () => '2026-11-01T00:00:00.000Z' });
    logger.info('登录失败', { actor: 'U-1' });
    logger.info('login failed', { actor: 'U-1' });
    logger.info('LOGIN_FAILED', { actor: 'U-1' });
    expect(sink).toHaveLength(1);
    expect(JSON.parse(sink[0] as string)).toMatchObject({ event: 'LOGIN_FAILED', fields: { actor: 'U-1' } });
  });

  it('超长字符串被截断，避免把整段文本带进日志', () => {
    const long = 'x'.repeat(500);
    const fields = redactFields({ path: long });
    expect(String(fields.path)).toHaveLength(200);
  });

  it('内存记录器不写标准输出，便于测试断言', () => {
    const logger = createMemoryLogger(() => '2026-11-01T00:00:00.000Z');
    logger.warn('AUDIT_CHAIN_BROKEN', { code: 'HASH_MISMATCH' });
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain('HASH_MISMATCH');
  });

  it('方法被解构后仍可调用，不因丢失 this 变成运行时故障', () => {
    const sink: string[] = [];
    const { info, error } = createLogger({ sink: (line) => sink.push(line), now: () => '2026-11-01T00:00:00.000Z' });
    info('HTTP_REQUEST', { method: 'GET' });
    error('HTTP_INTERNAL_ERROR', { code: 'INTERNAL_ERROR' });
    expect(sink).toHaveLength(2);
  });
});
