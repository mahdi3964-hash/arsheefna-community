import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {mkdirSync,copyFileSync,cpSync,readdirSync} from 'node:fs';
const require=createRequire(import.meta.url);
const root=resolve(import.meta.dirname,'..');
const target=join(root,'public','ocr');
mkdirSync(join(target,'lang'),{recursive:true});
const tesseract=dirname(require.resolve('tesseract.js/package.json'));
const core=dirname(createRequire(join(tesseract,'package.json')).resolve('tesseract.js-core/package.json'));
const pdf=dirname(require.resolve('pdfjs-dist/package.json'));
for(const name of ['tesseract.min.js','tesseract.min.js.LICENSE.txt','worker.min.js','worker.min.js.LICENSE.txt'])copyFileSync(join(tesseract,'dist',name),join(target,name));
for(const name of readdirSync(core).filter(x=>/^tesseract-core.*\.wasm\.js$/.test(x)))copyFileSync(join(core,name),join(target,name));
for(const [src,dest] of [['build/pdf.min.mjs','pdf.min.mjs'],['build/pdf.worker.min.mjs','pdf.worker.min.mjs'],['legacy/build/pdf.min.mjs','pdf-legacy.mjs'],['legacy/build/pdf.worker.min.mjs','pdf.worker-legacy.mjs']])copyFileSync(join(pdf,src),join(target,dest));
for(const name of ['cmaps','standard_fonts','wasm'])cpSync(join(pdf,name),join(target,name),{recursive:true});
copyFileSync(join(pdf,'LICENSE'),join(target,'PDFJS-LICENSE'));
copyFileSync(join(core,'LICENSE'),join(target,'TESSERACT-CORE-LICENSE'));
copyFileSync(join(tesseract,'LICENSE.md'),join(target,'TESSERACT-LICENSE.md'));
for(const lang of ['ara','eng']){const data=dirname(require.resolve('@tesseract.js-data/'+lang+'/package.json'));copyFileSync(join(data,'4.0.0_best_int',lang+'.traineddata.gz'),join(target,'lang',lang+'.traineddata.gz'));}
console.log('PDF and OCR runtime assets prepared.');
