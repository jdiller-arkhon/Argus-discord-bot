import { ConfigError } from '@arkhon/shared';
import { loadArgusConfig } from '../config.js';
import { type CheckStatus, inviteUrl, runChecks } from '../setup/checks.js';

// pnpm argus:doctor [--public-url https://<bot host>]
//
// Checks that every credential and ID in the environment works: the Discord
// token, the server and channels, the Argus API token, and (with --public-url)
// that Argus can reach the webhook. In a deployed container run
// `node dist/tools/doctor.js` instead.

const ICON: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✗' };

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadArgusConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`✗ Configuration\n${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const results = await runChecks(config.env, fetch, option(process.argv.slice(2), 'public-url'));
  for (const result of results) console.log(`${ICON[result.status]} ${result.name}: ${result.detail}`);
  console.log(`\nInvite link: ${inviteUrl(config.env.DISCORD_APPLICATION_ID, config.env.DISCORD_GUILD_ID)}`);

  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(failed ? `\n${failed} check(s) failed.` : '\nEverything the bot can check works.');
  if (failed) process.exitCode = 1;
}

await main();
