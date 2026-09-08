import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60000 });
  const dir = __dirname;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.test.js'))) mocha.addFile(path.join(dir, file));
  return new Promise((resolve, reject) => {
    mocha.run(failures => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
