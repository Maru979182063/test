import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadJobConfig } from './src/lib/config.mjs';
import { runPipeline } from './src/pipeline.mjs';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
  },
});

if (!values.config) {
  throw new Error('Missing --config. Example: node automation.mjs --config sample-job.json');
}

const configPath = path.resolve(process.cwd(), values.config);
const config = await loadJobConfig(configPath);
const result = await runPipeline(config);

console.log(JSON.stringify(result, null, 2));
