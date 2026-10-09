import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadEnv: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  bedrockSend: vi.fn(),
  runtimeSend: vi.fn(),
}));

vi.mock('dotenv', () => ({ config: mocks.loadEnv }));
vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
}));
vi.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: class { send = mocks.bedrockSend; },
  ListFoundationModelsCommand: class {
    constructor(input) { this.operation = 'models'; this.input = input; }
  },
  ListInferenceProfilesCommand: class {
    constructor(input) { this.operation = 'profiles'; this.input = input; }
  },
}));
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class { send = mocks.runtimeSend; },
  ConverseCommand: class {
    constructor(input) { this.input = input; }
  },
}));

const SONNET_55 = 'anthropic.claude-sonnet-5-5';
const SONNET_5 = 'anthropic.claude-sonnet-5';
const SONNET_45 = 'anthropic.claude-sonnet-4-5-20250929-v1:0';

function setCatalog(modelIds, profiles = []) {
  mocks.bedrockSend.mockImplementation(async ({ operation }) => {
    if (operation === 'models') {
      return { modelSummaries: modelIds.map((modelId) => ({ modelId, providerName: 'Anthropic' })) };
    }
    if (operation === 'profiles') return { inferenceProfileSummaries: profiles };
    throw new Error(`Unexpected Bedrock discovery operation: ${operation}`);
  });
}

function profile(inferenceProfileId, modelId = SONNET_55) {
  return {
    inferenceProfileId,
    models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${modelId}` }],
  };
}

function acceptOnly(modelId) {
  mocks.runtimeSend.mockImplementation(async ({ input }) => {
    if (input.modelId !== modelId) throw new Error('Not invokable');
    return {};
  });
}

async function runDiscovery() {
  // The CLI starts main() on import; wait for its mocked write rather than modifying
  // production code or performing any real AWS invocation or .env.local write.
  await import('../scripts/find-model.mjs');
  await vi.waitFor(() => {
    expect(console.error).not.toHaveBeenCalled();
    expect(mocks.writeFileSync).toHaveBeenCalledTimes(1);
  });
}

function attemptedModelIds() {
  return mocks.runtimeSend.mock.calls.map(([command]) => command.input.modelId);
}

describe('Bedrock Sonnet model discovery', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(mocks)) mock.mockReset();
    vi.stubEnv('AWS_REGION', 'us-east-1');
    mocks.existsSync.mockReturnValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => undefined);
  });

  afterEach(() => {
    const exitCalls = process.exit.mock.calls;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    expect(exitCalls).toEqual([]);
  });

  it('tries Sonnet 5.5, then Sonnet 5, then legacy Sonnet 4.5 regardless of catalog order', async () => {
    setCatalog([SONNET_45, SONNET_5, SONNET_55]);
    acceptOnly(SONNET_45);

    await runDiscovery();

    expect(attemptedModelIds()).toEqual([
      SONNET_55, `us.${SONNET_55}`, `global.${SONNET_55}`,
      SONNET_5, `us.${SONNET_5}`, `global.${SONNET_5}`,
      SONNET_45,
    ]);
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.env\.local$/),
      `BEDROCK_MODEL_ID=${SONNET_45}\n`,
    );
  });

  it('preserves registered profile order and deduplicates registered, US, and global IDs', async () => {
    const globalId = `global.${SONNET_55}`;
    const usId = `us.${SONNET_55}`;
    const customId = 'registered-sonnet-55';
    setCatalog([SONNET_5, SONNET_55], [
      profile(globalId),
      profile(customId),
      profile(globalId),
      profile(usId),
      profile(customId),
      profile(usId),
      profile('unrelated-profile', 'anthropic.claude-opus-other'),
    ]);
    acceptOnly(SONNET_5);

    await runDiscovery();

    expect(attemptedModelIds()).toEqual([SONNET_55, globalId, customId, usId, SONNET_5]);
  });

  it('selects the global naming fallback when direct and US invocations fail and preserves other env values', async () => {
    const globalId = `global.${SONNET_55}`;
    setCatalog([SONNET_55]);
    acceptOnly(globalId);
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(`AWS_REGION=us-east-1\nBEDROCK_MODEL_ID=${SONNET_45}\nOTHER_SETTING=kept\n`);

    await runDiscovery();

    expect(attemptedModelIds()).toEqual([SONNET_55, `us.${SONNET_55}`, globalId]);
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.env\.local$/),
      `AWS_REGION=us-east-1\nOTHER_SETTING=kept\nBEDROCK_MODEL_ID=${globalId}\n`,
    );
  });
});
