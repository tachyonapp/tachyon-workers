import { getBullMQConnectionOptions } from '../connection';

describe('getBullMQConnectionOptions', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns defaults when env vars are absent', () => {
    delete process.env.VALKEY_HOST;
    delete process.env.VALKEY_PORT;
    delete process.env.VALKEY_PASSWORD;
    delete process.env.VALKEY_TLS;

    const opts = getBullMQConnectionOptions();
    expect(opts.host).toBe('localhost');
    expect(opts.port).toBe(6379);
    expect(opts.password).toBeUndefined();
    expect(opts.tls).toBeUndefined();
  });

  it('returns env-provided values', () => {
    process.env.VALKEY_HOST = 'valkey.internal';
    process.env.VALKEY_PORT = '6380';
    process.env.VALKEY_PASSWORD = 'secret';
    process.env.VALKEY_TLS = 'true';

    const opts = getBullMQConnectionOptions();
    expect(opts.host).toBe('valkey.internal');
    expect(opts.port).toBe(6380);
    expect(opts.password).toBe('secret');
    expect(opts.tls).toEqual({});
  });

  it('sets TLS to undefined when VALKEY_TLS is false', () => {
    process.env.VALKEY_TLS = 'false';
    const opts = getBullMQConnectionOptions();
    expect(opts.tls).toBeUndefined();
  });

  it('sets password to undefined when VALKEY_PASSWORD is empty string', () => {
    process.env.VALKEY_PASSWORD = '';
    const opts = getBullMQConnectionOptions();
    expect(opts.password).toBeUndefined();
  });
});
