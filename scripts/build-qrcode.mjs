import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
await mkdir(new URL('../public/vendor/',import.meta.url),{recursive:true});
await build({stdin:{contents:"import QRCode from 'qrcode/lib/browser.js'; export const toCanvas=QRCode.toCanvas;",resolveDir:process.cwd(),sourcefile:'qrcode-entry.js'},bundle:true,format:'esm',platform:'browser',target:['safari15'],minify:true,outfile:'public/vendor/qrcode.js',legalComments:'eof'});
await writeFile('public/vendor/qrcode-LICENSE.txt',`qrcode\n${await readFile('node_modules/qrcode/license','utf8')}\n\nBundled dependency: dijkstrajs\n${await readFile('node_modules/dijkstrajs/LICENSE.md','utf8')}`);
console.log('Built local QR encoder; no remote QR service required.');
