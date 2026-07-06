import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadJobConfig } from './src/lib/config.mjs';
import { checkArkProvider } from './src/adapters/ark-model.mjs';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
  },
});

if (!values.config) {
  throw new Error('Missing --config. Example: node check-ark.mjs --config smoke-job.physics.json');
}

const configPath = path.resolve(process.cwd(), values.config);
const config = await loadJobConfig(configPath);
const result = await checkArkProvider(config.provider);

console.log(JSON.stringify(result, null, 2));
