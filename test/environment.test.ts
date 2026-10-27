import { describe, expect, it } from 'vitest';

import { buildChildEnvironment } from '../src/adapters/environment.js';

const source: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/home/dev',
  LC_ALL: 'C.UTF-8',
  HTTPS_PROXY: 'http://proxy:8080',
  ANTHROPIC_API_KEY: 'sk-ant',
  ANTHROPIC_BASE_URL: 'https://gateway.example',
  CLAUDE_CODE_USE_BEDROCK: '1',
  OPENAI_API_KEY: 'sk-openai',
  GITHUB_TOKEN: 'ghp_secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
};

describe('buildChildEnvironment', () => {
  it('passes only allowlisted variables and strips billing variables in subscription mode', () => {
    const environment = buildChildEnvironment(source, { billingMode: 'subscription', platform: 'linux' });
    expect(environment).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      LC_ALL: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy:8080',
    });
  });

  it('matches names case-insensitively on Windows and disables current-directory command lookup', () => {
    const environment = buildChildEnvironment(
      { Path: 'C:\\Windows', anthropic_api_key: 'sk-ant', Openai_Api_Key: 'sk-openai', SystemRoot: 'C:\\Windows' },
      { billingMode: 'subscription', platform: 'win32' },
    );
    expect(environment).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', NoDefaultCurrentDirectoryInExePath: '1' });
  });

  it('lets the user pass extra names, but never billing variables in subscription mode', () => {
    const environment = buildChildEnvironment(source, {
      billingMode: 'subscription',
      passthrough: ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY'],
      platform: 'linux',
    });
    expect(environment.GITHUB_TOKEN).toBe('ghp_secret');
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('passes billing variables in environment mode', () => {
    const environment = buildChildEnvironment(source, { billingMode: 'environment', platform: 'linux' });
    expect(environment).toMatchObject({ ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-openai', CLAUDE_CODE_USE_BEDROCK: '1' });
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});
