import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { runConfigCommand } from '../config-command.js';

const TEST_DIRECTORY_PREFIX = 'pure-agent-cli-config-';
const TEST_CONFIG_FILE_NAME = 'config.json';
const TEST_API_KEY = 'sk-piped-test-key';
const NEWLINE = '\n';
const CLI_ENTRY_PATH = join(process.cwd(), 'dist', 'index.js');
const CONFIG_COMMAND_ARGUMENTS = ['config', 'show'];
const HOME_ENVIRONMENT_VARIABLE = 'HOME';

class CapturedOutput {
  value = '';

  write(chunk: string): boolean {
    this.value += chunk;
    return true;
  }
}

let temporaryDirectory: string;
let configPath: string;

function createDependencies(input: AsyncIterable<unknown>, output: CapturedOutput) {
  return {
    input,
    output,
    configPath,
    isInteractive: false,
  };
}

describe('runConfigCommand', () => {
  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), TEST_DIRECTORY_PREFIX));
    configPath = join(temporaryDirectory, TEST_CONFIG_FILE_NAME);
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('通过 stdin 保存 API Key 且不回显密钥', async () => {
    const output = new CapturedOutput();

    await runConfigCommand(
      ['set', 'api-key', '--stdin'],
      createDependencies(Readable.from([`${TEST_API_KEY}${NEWLINE}`]), output),
    );

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      provider: { apiKey: TEST_API_KEY },
    });
    expect(output.value).not.toContain(TEST_API_KEY);
    expect(output.value).toMatch(/saved/i);
  });

  it('show 只输出脱敏 API Key', async () => {
    writeFileSync(configPath, JSON.stringify({ provider: { apiKey: TEST_API_KEY } }));
    const output = new CapturedOutput();

    await runConfigCommand(['show'], createDependencies(Readable.from([]), output));

    expect(output.value).not.toContain(TEST_API_KEY);
    expect(output.value).toMatch(/API Key: sk-…/);
  });

  it('拒绝非交互模式下未带 --stdin 的密钥设置', async () => {
    const output = new CapturedOutput();

    await expect(
      runConfigCommand(['set', 'api-key'], createDependencies(Readable.from([]), output)),
    ).rejects.toThrow(/--stdin/i);
  });

  it('编译后的 CLI 将 config show 路由到配置命令', () => {
    const result = spawnSync(process.execPath, [CLI_ENTRY_PATH, ...CONFIG_COMMAND_ARGUMENTS], {
      env: {
        ...process.env,
        [HOME_ENVIRONMENT_VARIABLE]: temporaryDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('API Key: not configured');
  });
});
