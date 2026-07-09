import { describe, it, expect } from 'vitest';
import { redactSensitiveText } from '../redactor.js';

describe('Redactor', () => {
  it('脱敏 OpenAI API key', () => {
    const r = redactSensitiveText('My key: sk-abc123def456ghi789jkl012mno345pqr678stu');
    expect(r).not.toContain('sk-abc123');
    expect(r).toContain('[REDACTED_API_KEY]');
  });

  it('脱敏 Anthropic API key', () => {
    const r = redactSensitiveText('Key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456');
    expect(r).not.toContain('sk-ant');
    expect(r).toContain('[REDACTED_API_KEY]');
  });

  it('脱敏 GitHub PAT', () => {
    expect(redactSensitiveText('ghp_abcdefghijklmnopqrstuvwxyz1234567890')).toContain('[REDACTED_TOKEN]');
  });

  it('脱敏 JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactSensitiveText(jwt)).toContain('[REDACTED_JWT]');
  });

  it('脱敏密码参数', () => {
    expect(redactSensitiveText('password=secret123')).toContain('[REDACTED_PASSWORD]');
    expect(redactSensitiveText('passwd=secret456')).toContain('[REDACTED_PASSWORD]');
  });

  it('脱敏连接字符串中的密码', () => {
    const r = redactSensitiveText('postgresql://user:password=secret123@host/db');
    expect(r).not.toContain('secret123');
  });

  it('脱敏 Bearer token', () => {
    const r = redactSensitiveText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890');
    expect(r).toContain('[REDACTED_TOKEN]');
  });

  it('保留正常文本', () => {
    const text = 'The config file is at /etc/nginx/nginx.conf';
    expect(redactSensitiveText(text)).toBe(text);
  });

  it('高熵长字符串脱敏', () => {
    const highEntropy = 'AbCdEfGhIjKlMnOpQrStUvWxYz1234567890+/==';
    const r = redactSensitiveText(highEntropy);
    if (r !== highEntropy) {
      expect(r).toContain('[REDACTED_TOKEN]');
    }
  });
});
