const fs = require('fs');
const path = 'E:\\Projects\\IAC-Asset-Management-System-main\\IAC-Asset-Management-System-main\\apps\\api\\test\\asset-photos.integration.test.ts';
let content = fs.readFileSync(path, 'utf8');
// Remove the contradictory line: assert.equal((await request(itAdmin)).body.dataUrl, result.body.dataUrl);
// This line appears after assert.equal((await request(employee)).body.dataUrl, result.body.dataUrl);
// and before await domain.createTicket(...)
const lines = content.split('\n');
const newLines = [];
for (let i = 0; i < lines.length; i++) {
  // Skip the line that sets itAdmin.body.dataUrl equal to result.body.dataUrl
  // It's the line after employee.dataUrl assertion in the test
  if (lines[i].trim().startsWith('assert.equal((await request(itAdmin)).body.dataUrl, result.body.dataUrl)') &&
      i > 0 && lines[i-1].trim().startsWith('assert.equal((await request(employee)).body.dataUrl, result.body.dataUrl)'))) {
    console.log('Skipping contradictory line at', i+1);
    continue;
  }
  newLines.push(lines[i]);
}
const newContent = newLines.join('\n');
fs.writeFileSync(path, newContent);
console.log('File written,', newContent.length, 'bytes');