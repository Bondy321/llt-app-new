'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyPatches } = require('../../scripts/security/dependencyPatches');

const root = path.resolve(__dirname, '../..');
const installed = applyPatches(root, true);
const run = (location, source) => {
  const result = spawnSync(process.execPath, ['--stack-size=768', '--max-old-space-size=96', '-e', `const assert=require('node:assert/strict'); const library=require(${JSON.stringify(path.join(root, location))});\n${source}`], { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 8192 });
  assert.equal(result.error, undefined, 'bounded regression process completes');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
};

for (const copy of installed) {
  if (copy.package === 'braces') {
    test(`${copy.location}: normal CLI/Metro globs preserve their expansion and compilation`, () => run(copy.location, `
      assert.deepEqual(library.expand('src/{screens,services}/**/*.{js,jsx}'), ['src/screens/**/*.js','src/screens/**/*.jsx','src/services/**/*.js','src/services/**/*.jsx']);
      assert.equal(library.compile('a/{b,c}/d'), 'a/(b|c)/d');
      assert.deepEqual(library.expand('file-{01..03}.js'), ['file-01.js','file-02.js','file-03.js']);
      assert.deepEqual(library.expand('a/{b,b,c}', {nodupes:true}), ['a/b','a/c']);
      assert.equal(library.stringify(library.parse('foo/{a,b}/bar')), 'foo/{a,b}/bar');
      const escaped='\\\\{literal\\\\}'; assert.equal(library.compile(escaped), '{literal}');
      assert.deepEqual(library.expand('"{a,b}"'), ['{a,b}']);
    `));
    test(`${copy.location}: deep string and AST entrypoints survive without recursive overflow`, () => run(copy.location, `
      for (const pattern of ['{'.repeat(4000)+'a,b'+'}'.repeat(4000), '('.repeat(4000)+'a'+')'.repeat(4000), '{('.repeat(1500)+'a'+')}'.repeat(1500), '{'.repeat(150)+'a{2}(b|c)[x].*+?^$'+String.fromCharCode(92)+'}'.repeat(150)]) {
        const compiled=library.compile(pattern);
        const regex=new RegExp('^(?:'+compiled+')$');
        assert.equal(regex.test(pattern),true);
        assert.equal(regex.test('a'),false);
        assert.equal(regex.test(pattern.slice(1)),false);
        assert.equal(library.compile(library.parse(pattern)),compiled);
        assert.deepEqual(library.expand(pattern), [pattern]);
        assert.equal(library.stringify(pattern), pattern);
        assert.equal(library.stringify(library.parse(pattern)), pattern);
        assert.deepEqual(library(pattern), [compiled]);
      }
      const raw='a{2}(b|c)[x].*+?^$'+String.fromCharCode(92);
      let ast={type:'text',value:raw};
      for(let i=0;i<4000;i++) ast={type:'root',nodes:[ast]};
      const regex=new RegExp('^(?:'+library.compile(ast)+')$');
      assert.equal(regex.test(raw),true); assert.equal(regex.test('aabx'),false);
      assert.equal(regex.test(raw.replace('a{2}','aa')),false);
      assert.deepEqual(library.expand(ast),[raw]); assert.equal(library.stringify(ast),raw);
      const cycle={type:'root',nodes:[]}; cycle.nodes=[cycle,{type:'text',value:'safe'}];
      assert.equal(library.compile(cycle),'safe'); assert.deepEqual(library.expand(cycle),['safe']); assert.equal(library.stringify(cycle),'safe');
      const shared={type:'text',value:'one'},alias={type:'root',nodes:[shared,shared]};
      assert.equal(library.compile(alias),'one'); assert.deepEqual(library.expand(alias),['one']);
      const parentCycle={type:'paren',nodes:[{type:'text',value:'safe'}]}; parentCycle.parent=parentCycle;
      assert.equal(library.compile(parentCycle),'safe'); assert.deepEqual(library.expand(parentCycle),['safe']); assert.equal(library.stringify(parentCycle),'safe');
    `));
  }
  if (copy.package === 'sprintf-js') {
    test(`${copy.location}: ordinary formatting remains compatible and every numeric precision is bounded`, () => run(copy.location, `
      const {sprintf,vsprintf}=library;
      assert.equal(sprintf('%s %04d %.2f','file',7,1.25),'file 0007 1.25');
      assert.equal(vsprintf('%+6.2f',[1.5]),' +1.50');
      assert.equal(sprintf('%.2e',1),'1.00e+0'); assert.equal(sprintf('%.2g',1.25),'1.3');
      assert.equal(sprintf('%.0f',1.9),'2'); assert.equal(sprintf('%.0e',1),'1e+0');
      for(const precision of ['101','9999999999999999999999999999999999','9'.repeat(1000)]) {
        for(const kind of ['f','e','g']) assert.equal(sprintf('%.'+precision+kind,1),sprintf('%.100'+kind,1));
      }
      assert.equal(sprintf('%.0g',1.25),sprintf('%.1g',1.25));
      // Exercise the event-loop path responsible for the advisory's process exit.
      setImmediate(()=>assert.equal(sprintf('%.101f',1),sprintf('%.100f',1)));
    `));
  }
  if (copy.package === 'node-forge') {
    test(`${copy.location}: valid RSA signatures work and signed nested garbage is rejected`, () => run(copy.location, `
      const {generateKeyPairSync}=require('node:crypto');
      const {privateKey}=generateKeyPairSync('rsa',{modulusLength:1024,publicExponent:3});
      const key=library.pki.privateKeyFromPem(privateKey.export({type:'pkcs1',format:'pem'}));
      const pub=library.pki.setRsaPublicKey(key.n,key.e),a=library.asn1;
      const make=(type,constructed,value)=>a.create(a.Class.UNIVERSAL,type,constructed,value);
      const md=library.md.sha256.create().update('synthetic local regression');
      const digest=md.digest().getBytes();
      assert.equal(pub.verify(digest,key.sign(md)),true);
      assert.equal(pub.verify(library.md.sha256.create().update('different').digest().getBytes(),key.sign(md)),false);
      const oid=make(a.Type.OID,false,a.oidToDer(library.oids.sha256).getBytes());
      const nil=make(a.Type.NULL,false,''); const garbage=make(a.Type.OCTETSTRING,false,'garbage');
      for(const algorithm of [[oid],[oid,nil]]) {
        const der=a.toDer(make(a.Type.SEQUENCE,true,[make(a.Type.SEQUENCE,true,algorithm),make(a.Type.OCTETSTRING,false,digest)])).getBytes();
        assert.equal(pub.verify(digest,key.sign(der,'NONE')),true);
      }
      for(const algorithm of [[oid,garbage],[oid,nil,garbage],[oid,nil,nil]]) {
        const der=a.toDer(make(a.Type.SEQUENCE,true,[make(a.Type.SEQUENCE,true,algorithm),make(a.Type.OCTETSTRING,false,digest)])).getBytes();
        assert.throws(()=>pub.verify(digest,key.sign(der,'NONE')),/valid RSASSA/);
      }
    `));
  }
}
