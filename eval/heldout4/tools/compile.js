const path = require('path');
const fs = require('fs');
const solc = require(path.resolve(__dirname, '../../evm/node_modules/solc'));
const dir = path.resolve(__dirname, '../contracts');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sol')).sort();
let fail = 0;
for (const f of files) {
  const input = { language: 'Solidity', sources: { [f]: { content: fs.readFileSync(path.join(dir, f), 'utf8') } },
    settings: { outputSelection: { '*': { '*': ['evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter(e => e.severity === 'error');
  if (errs.length) { fail++; console.log('FAIL', f); errs.forEach(e => console.log(e.formattedMessage)); }
}
console.log('compiler', solc.version());
console.log(`${files.length - fail}/${files.length} compiled`);
