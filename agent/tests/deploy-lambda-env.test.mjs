import { describe, expect, it } from 'vitest';
import {
  assertActionRuntimeDeployConfiguration,
  assertDeployStagingTarget,
  buildLambdaEnv,
} from '../scripts/deploy-lambda.mjs';

const ACTION_ENV = {
  COPILOT_ACTIONS_RUNTIME_ENABLED: 'true',
  COPILOT_CAPABILITY_HMAC_KEY: 'not-a-real-secret',
  COPILOT_CAPABILITY_KID: 'staging-kid-1',
  CRDB_CONNECTION_STRING: 'postgresql://deploy-test-only',
};

describe('Lambda action-runtime deployment environment', () => {
  it('validates and includes every enabled action-runtime key without printing values', () => {
    expect(assertActionRuntimeDeployConfiguration(ACTION_ENV)).toBe(true);
    expect(buildLambdaEnv(ACTION_ENV)).toMatchObject(ACTION_ENV);
  });

  it('leaves actions disabled by default when action variables are absent', () => {
    expect(assertActionRuntimeDeployConfiguration({})).toBe(false);
    expect(buildLambdaEnv({})).not.toHaveProperty('COPILOT_ACTIONS_RUNTIME_ENABLED');
  });

  it.each([
    ['COPILOT_CAPABILITY_HMAC_KEY'],
    ['COPILOT_CAPABILITY_KID'],
    ['CRDB_CONNECTION_STRING'],
  ])('refuses enabled action runtime when %s is absent', (missingKey) => {
    const env = { ...ACTION_ENV };
    delete env[missingKey];
    expect(() => assertActionRuntimeDeployConfiguration(env)).toThrow(missingKey);
  });

  it('refuses a production Supabase target', () => {
    expect(() => assertDeployStagingTarget({
      POS_SUPABASE_URL: 'https://production-project.supabase.co',
    })).toThrow(/SAFETY ABORT/);
  });
});
