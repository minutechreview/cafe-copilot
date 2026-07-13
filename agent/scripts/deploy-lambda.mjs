// Idempotent deploy script for the Cafe Copilot Lambda: IAM execution role -> function code
// (create or update) -> reserved concurrency -> public Function URL with CORS. Uses the AWS
// SDK v3 directly (no AWS CLI on this machine) and the credentials already present in
// process.env after loadEnv (the SDK's default credential provider chain picks up
// AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_REGION from the environment automatically).
//
// PERMISSION SHAPE: the deploy IAM user (cafe-copilot-dev) has a policy scoped to resources
// named `cafe-copilot*`. List* actions (ListFunctions, ListRoles, ...) are therefore DENIED —
// every "does this already exist" check below uses a Get* call on the exact resource name and
// branches on the not-found error, never a List call.
//
// Usage: node scripts/deploy-lambda.mjs [extraCorsOrigin]
//   extraCorsOrigin - an additional allowed CORS origin (e.g. the real Cloudflare Pages URL,
//   once known) merged with the built-in defaults. Re-running this script is always safe:
//   every step below is a create-if-missing-else-update operation.
import { config as loadEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  IAMClient,
  GetRoleCommand,
  CreateRoleCommand,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  LambdaClient,
  GetFunctionCommand,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  GetFunctionConfigurationCommand,
  PutFunctionConcurrencyCommand,
  GetFunctionUrlConfigCommand,
  CreateFunctionUrlConfigCommand,
  UpdateFunctionUrlConfigCommand,
  AddPermissionCommand,
} from '@aws-sdk/client-lambda';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const AGENT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(AGENT_DIR);
loadEnv({ path: path.join(REPO_ROOT, '.env.local') });

const ROLE_NAME = 'cafe-copilot-agent-role';
const FUNCTION_NAME = 'cafe-copilot-agent';
const ZIP_PATH = path.join(AGENT_DIR, 'dist-lambda', 'function.zip');
const RUNTIME_CANDIDATES = ['nodejs22.x', 'nodejs20.x'];
const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'https://cafe-copilot.pages.dev'];
// Only these keys from .env.local are needed by the Lambda code (see handler.mjs, tools.mjs,
// embeddings.mjs, pos-client.mjs, memory/store.mjs) — AWS_* vars are deliberately excluded:
// AWS_REGION is provided by the Lambda runtime automatically and can't be overridden, and no
// static AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY should ever reach the deployed function (it
// must rely on the execution role via the default credential chain).
const LAMBDA_ENV_KEYS = [
  'CRDB_CONNECTION_STRING',
  'BEDROCK_MODEL_ID',
  'BEDROCK_EMBEDDING_MODEL_ID',
  'EMBEDDING_DIM',
  'DEMO_BUSINESS_ID',
  'POS_SUPABASE_URL',
  'POS_SUPABASE_ANON_KEY',
  'DEMO_OWNER_EMAIL',
  'DEMO_OWNER_PASSWORD',
];

const region = process.env.AWS_REGION;
if (!region) {
  throw new Error('AWS_REGION is not configured in .env.local');
}

const iam = new IAMClient({ region });
const lambdaClient = new LambdaClient({ region });
const sts = new STSClient({ region });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TRUST_POLICY = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
};

function buildInlinePolicy(accountId) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'BedrockInvoke',
        Effect: 'Allow',
        Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        Resource: '*',
      },
      {
        Sid: 'LambdaLogs',
        Effect: 'Allow',
        Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: `arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${FUNCTION_NAME}:*`,
      },
    ],
  };
}

function buildLambdaEnv() {
  const env = {};
  for (const key of LAMBDA_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function getAccountId() {
  const res = await sts.send(new GetCallerIdentityCommand({}));
  return res.Account;
}

/** Get-then-create-or-update the IAM execution role; the inline policy is re-applied on every
 * run (PutRolePolicy overwrites, so this stays correct if the policy shape ever changes). */
async function ensureRole(accountId) {
  let role;
  let created = false;
  try {
    const res = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    role = res.Role;
    console.log('[deploy] IAM role exists:', role.Arn);
  } catch (err) {
    if (err.name !== 'NoSuchEntityException') throw err;
    const res = await iam.send(
      new CreateRoleCommand({
        RoleName: ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify(TRUST_POLICY),
        Description: 'Execution role for the Cafe Copilot chat agent Lambda',
      })
    );
    role = res.Role;
    created = true;
    console.log('[deploy] created IAM role:', role.Arn);
  }

  await iam.send(
    new PutRolePolicyCommand({
      RoleName: ROLE_NAME,
      PolicyName: 'cafe-copilot-agent-inline-policy',
      PolicyDocument: JSON.stringify(buildInlinePolicy(accountId)),
    })
  );
  console.log('[deploy] inline policy attached (bedrock:InvokeModel*, logs:*)');

  if (created) {
    console.log('[deploy] waiting ~10s for IAM propagation before using the new role...');
    await sleep(10000);
  }

  return role.Arn;
}

async function getExistingRuntime() {
  try {
    const res = await lambdaClient.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
    return res.Configuration.Runtime;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

async function waitForFunctionReady() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const res = await lambdaClient.send(new GetFunctionConfigurationCommand({ FunctionName: FUNCTION_NAME }));
    if (res.State !== 'Pending' && res.LastUpdateStatus !== 'InProgress') return res;
    await sleep(2000);
  }
  throw new Error('Timed out waiting for the Lambda function to finish updating');
}

async function createFunctionWithRetry({ runtime, roleArn, zipBuffer, envVars }) {
  const attempts = 6;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await lambdaClient.send(
        new CreateFunctionCommand({
          FunctionName: FUNCTION_NAME,
          Runtime: runtime,
          Role: roleArn,
          Handler: 'index.handler',
          Code: { ZipFile: zipBuffer },
          MemorySize: 512,
          Timeout: 60,
          Environment: { Variables: envVars },
          Publish: false,
        })
      );
      console.log(`[deploy] created function ${FUNCTION_NAME} (runtime ${runtime})`);
      return runtime;
    } catch (err) {
      const roleNotReady =
        err.name === 'InvalidParameterValueException' &&
        /cannot be assumed|role defined for the function/i.test(err.message ?? '');
      if (roleNotReady && attempt < attempts - 1) {
        console.log('[deploy] execution role not yet propagated, retrying in 2s...');
        await sleep(2000);
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

async function createFunctionWithFallback({ roleArn, zipBuffer, envVars }) {
  let lastErr;
  for (const runtime of RUNTIME_CANDIDATES) {
    try {
      return await createFunctionWithRetry({ runtime, roleArn, zipBuffer, envVars });
    } catch (err) {
      lastErr = err;
      if (err.name === 'InvalidParameterValueException' && /runtime/i.test(err.message ?? '')) {
        console.warn(`[deploy] runtime ${runtime} rejected, trying next candidate`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function updateExistingFunction({ roleArn, zipBuffer, envVars, runtime }) {
  await lambdaClient.send(new UpdateFunctionCodeCommand({ FunctionName: FUNCTION_NAME, ZipFile: zipBuffer }));
  console.log('[deploy] updated function code');
  await waitForFunctionReady();

  await lambdaClient.send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: FUNCTION_NAME,
      Role: roleArn,
      Handler: 'index.handler',
      Runtime: runtime,
      MemorySize: 512,
      Timeout: 60,
      Environment: { Variables: envVars },
    })
  );
  console.log('[deploy] updated function configuration');
  await waitForFunctionReady();
}

async function ensureFunction({ roleArn, zipBuffer, envVars }) {
  const existingRuntime = await getExistingRuntime();
  if (!existingRuntime) {
    return createFunctionWithFallback({ roleArn, zipBuffer, envVars });
  }
  console.log(`[deploy] function ${FUNCTION_NAME} exists (runtime ${existingRuntime}), updating`);
  await updateExistingFunction({ roleArn, zipBuffer, envVars, runtime: existingRuntime });
  return existingRuntime;
}

/** Cost guardrail: caps concurrent executions so a runaway loop can't rack up an open-ended
 * Bedrock/Lambda bill. */
async function ensureConcurrency() {
  try {
    await lambdaClient.send(
      new PutFunctionConcurrencyCommand({ FunctionName: FUNCTION_NAME, ReservedConcurrentExecutions: 5 })
    );
    console.log('[deploy] reserved concurrency set to 5');
  } catch (err) {
    // New/small AWS accounts have a low total concurrency quota (often 10), and reserving any
    // of it would drop the unreserved pool below AWS's required minimum -- a 400. The
    // reservation is a nice-to-have cost guardrail, not a correctness requirement (per-reply
    // token caps and the billing alarm remain), so warn and continue instead of failing.
    console.warn(`[deploy] WARNING: could not reserve concurrency (${err.name}). Continuing without it.`);
  }
}

async function ensureFunctionUrl(corsOrigins) {
  let existing;
  try {
    existing = await lambdaClient.send(new GetFunctionUrlConfigCommand({ FunctionName: FUNCTION_NAME }));
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') throw err;
  }

  const params = {
    FunctionName: FUNCTION_NAME,
    AuthType: 'NONE',
    InvokeMode: 'RESPONSE_STREAM',
    Cors: { AllowOrigins: corsOrigins, AllowMethods: ['POST'], AllowHeaders: ['content-type'] },
  };

  if (!existing) {
    const res = await lambdaClient.send(new CreateFunctionUrlConfigCommand(params));
    console.log('[deploy] created Function URL:', res.FunctionUrl);
    return res.FunctionUrl;
  }

  await lambdaClient.send(new UpdateFunctionUrlConfigCommand(params));
  console.log('[deploy] updated Function URL CORS config:', corsOrigins.join(', '));
  return existing.FunctionUrl;
}

/** FunctionUrlAuthType NONE still requires an explicit resource-policy statement granting
 * public invoke — AddPermission is not idempotent, so a ResourceConflictException (the
 * statement already exists) is treated as success rather than an error. */
async function ensurePublicInvokePermission() {
  try {
    await lambdaClient.send(
      new AddPermissionCommand({
        FunctionName: FUNCTION_NAME,
        StatementId: 'FunctionURLAllowPublicAccess',
        Action: 'lambda:InvokeFunctionUrl',
        Principal: '*',
        FunctionUrlAuthType: 'NONE',
      })
    );
    console.log('[deploy] added public Function URL invoke permission');

  // Since October 2025 AWS requires BOTH lambda:InvokeFunctionUrl AND a plain
  // lambda:InvokeFunction grant in the resource policy for a public (AuthType NONE)
  // Function URL -- with only the former, every unsigned request gets 403 Forbidden.
  // The FunctionUrlAuthType condition key is not accepted on InvokeFunction, so this
  // statement is unconditional; the function is public by design, so the exposure is
  // identical to the URL itself.
  try {
    await lambdaClient.send(
      new AddPermissionCommand({
        FunctionName: FUNCTION_NAME,
        StatementId: 'FunctionURLPublicInvokeFunction',
        Action: 'lambda:InvokeFunction',
        Principal: '*',
      })
    );
    console.log('[deploy] added public InvokeFunction permission (Oct 2025 requirement)');
  } catch (err) {
    if (err.name !== 'ResourceConflictException') throw err;
    console.log('[deploy] public InvokeFunction permission already present');
  }
  } catch (err) {
    if (err.name === 'ResourceConflictException') {
      console.log('[deploy] public Function URL invoke permission already present');
      return;
    }
    throw err;
  }
}

async function main() {
  const accountId = await getAccountId();
  console.log(`[deploy] account ${accountId}, region ${region}`);

  const roleArn = await ensureRole(accountId);

  let zipBuffer;
  try {
    zipBuffer = await readFile(ZIP_PATH);
  } catch {
    throw new Error(`Bundle not found at ${ZIP_PATH} — run "npm run bundle --workspace=agent" first`);
  }

  const envVars = buildLambdaEnv();
  const runtime = await ensureFunction({ roleArn, zipBuffer, envVars });
  await ensureConcurrency();

  const extraOrigin = process.argv[2];
  const corsOrigins = Array.from(new Set([...DEFAULT_CORS_ORIGINS, ...(extraOrigin ? [extraOrigin] : [])]));
  const functionUrl = await ensureFunctionUrl(corsOrigins);
  await ensurePublicInvokePermission();

  console.log('\n[deploy] done.');
  console.log('Runtime:', runtime);
  console.log('Function URL:', functionUrl);
  console.log('CORS origins:', corsOrigins.join(', '));
}

main().catch((err) => {
  console.error('[deploy] failed:', err);
  process.exitCode = 1;
});
