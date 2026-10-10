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

const HAIKU_55 = 'anthropic.claude-haiku-5-5';
const SONNET_55 = 'anthropic.claude-sonnet-5-5';
const SONNET_5 = 'anthropic.claude-sonnet-5';
const SONNET_45 = 'anthropic.claude-sonnet-4-5-20250929-v1:0';

function setCatalog(models, profiles = []) {
  mocks.bedrockSend.mockImplementation(async ({ operation }) => {
    if (operation === 'models') {
      return {
        modelSummaries: models.map((model) => typeof model === 'string'
          ? { modelId: model, providerName: 'Anthropic' }
          : model),
      };
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

function listedModelIds() {
  return console.log.mock.calls
    .map(([message]) => message)
    .filter((message) => message.startsWith('  - '))
    .map((message) => message.slice('  - '.length));
}

describe('Bedrock Claude model discovery', () => {
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

  it('prefers Haiku 5.5 over the Sonnet families and writes its US profile from a scrambled catalog', async () => {
    const usId = `us.${HAIKU_55}`;
    setCatalog([SONNET_45, SONNET_55, SONNET_5, HAIKU_55]);
    acceptOnly(usId);

    await runDiscovery();

    expect(listedModelIds()).toEqual([HAIKU_55, SONNET_55, SONNET_5, SONNET_45]);
    expect(attemptedModelIds()).toEqual([HAIKU_55, usId]);
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.env\.local$/),
      `BEDROCK_MODEL_ID=${usId}\n`,
    );
  });

  it('selects the Haiku 5.5 global fallback after direct and deduplicated registered US attempts fail', async () => {
    const usId = `us.${HAIKU_55}`;
    const globalId = `global.${HAIKU_55}`;
    setCatalog([SONNET_55, HAIKU_55], [
      profile(usId, HAIKU_55),
      profile(usId, HAIKU_55),
      profile('unrelated-sonnet-profile', SONNET_55),
    ]);
    acceptOnly(globalId);

    await runDiscovery();

    expect(attemptedModelIds()).toEqual([HAIKU_55, usId, globalId]);
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.env\.local$/),
      `BEDROCK_MODEL_ID=${globalId}\n`,
    );
  });

  it('retains Sonnet 5.5 when Haiku 5.5 is unavailable and excludes older Haiku, Opus, and other providers', async () => {
    const haikuUsId = `us.${HAIKU_55}`;
    const haikuGlobalId = `global.${HAIKU_55}`;
    const sonnetUsId = `us.${SONNET_55}`;
    setCatalog([
      'anthropic.claude-haiku-4-5-20251001-v1:0',
      { modelId: 'other.claude-haiku-5-5', providerName: 'Other provider' },
      SONNET_55,
      'anthropic.claude-opus-5-5',
      { modelId: 'other.claude-sonnet-5-5', providerName: 'Other provider' },
      HAIKU_55,
    ], [
      profile(haikuUsId, HAIKU_55),
      profile(haikuUsId, HAIKU_55),
      profile(haikuGlobalId, HAIKU_55),
      profile(haikuGlobalId, HAIKU_55),
    ]);
    acceptOnly(sonnetUsId);

    await runDiscovery();

    expect(listedModelIds()).toEqual([HAIKU_55, SONNET_55]);
    expect(attemptedModelIds()).toEqual([
      HAIKU_55, haikuUsId, haikuGlobalId, SONNET_55, sonnetUsId,
    ]);
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.env\.local$/),
      `BEDROCK_MODEL_ID=${sonnetUsId}\n`,
    );
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
