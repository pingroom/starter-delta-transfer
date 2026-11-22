import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildDelta, applyDelta, validateInput, deltaPlan, requestFor, POLICY_HASH, MAX_BYTES, MIN_COPY } from '../src/model.js';
import { CONFIG, id } from '../src/mock.js';
const hex = bytes => Buffer.from(bytes).toString('hex');
const inputFor = (base, target) => ({ transferId:'fixture',title:'Byte transfer',context:'Installed baseline record',targetHex:hex(target),baselines:[{id:'base',label:'Installed base',reference:'Record A',hex:hex(base)}] });
const digest = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
function oracle(base,target) {
  const ops=[];let cursor=0, literal=[];
  const flush=()=>{if(literal.length){ops.push({type:'LITERAL',hex:hex(literal)});literal=[];}};
  while(cursor<target.length){
    let best=0,at=0;
    for(let offset=0;offset<base.length;offset++){
      let count=0;while(cursor+count<target.length&&offset+count<base.length&&target[cursor+count]===base[offset+count])count++;
      if(count>best){best=count;at=offset;}
    }
    if(best>=4){flush();ops.push({type:'COPY',offset:at,length:best});cursor+=best;}
    else literal.push(target[cursor++]);
  }
  flush();return ops;
}
function independentlyApply(ops,base){const out=[];for(const op of ops){if(op.type==='COPY')for(let k=0;k<op.length;k++)out.push(base[op.offset+k]);else for(let k=0;k<op.hex.length;k+=2)out.push(parseInt(op.hex.slice(k,k+2),16));}return out;}
function words(n){return Array.from({length:2**n},(_,v)=>Array.from({length:n},(_,i)=>(v>>i)&1));}
test('empty input yields an empty patch and verifies the empty byte digest',()=>{
  const result=buildDelta(inputFor([],[]),'base');assert.deepEqual(result.patch.operations,[]);assert.equal(result.patch.target.sha256,digest([]));assert.equal(applyDelta(result.patch,''),'');
});
test('identical baseline uses one copy; short matches remain a single literal',()=>{
  assert.deepEqual(buildDelta(inputFor([0,1,2,3],[0,1,2,3]),'base').patch.operations,[{type:'COPY',offset:0,length:4}]);
  assert.deepEqual(buildDelta(inputFor([0,1,2],[0,1,2]),'base').patch.operations,[{type:'LITERAL',hex:'000102'}]);
});
test('longest match wins and repeated equal-length matches choose lowest offset',()=>{
  const base=[8,1,2,3,4,9,1,2,3,4,5];
  assert.deepEqual(buildDelta(inputFor(base,[1,2,3,4]),'base').patch.operations,[{type:'COPY',offset:1,length:4}]);
  assert.deepEqual(buildDelta(inputFor(base,[1,2,3,4,5]),'base').patch.operations,[{type:'COPY',offset:6,length:5}]);
});
test('copy only references baseline and may repeat or move backwards',()=>{
  const base=[0,1,2,3,4,5,6,7],target=[4,5,6,7,0,1,2,3,4,5,6,7];
  const result=buildDelta(inputFor(base,target),'base');assert.deepEqual(result.patch.operations,[{type:'COPY',offset:4,length:4},{type:'COPY',offset:0,length:8}]);assert.deepEqual(independentlyApply(result.patch.operations,base),target);
});
test('exhaustive small byte sequences match an independent greedy encoder and interpreter',()=>{
  const cases=[...words(0),...words(1),...words(2),...words(3),...words(4),...words(5),...words(6)];let count=0;
  for(const base of cases)for(const target of cases){
    const input=inputFor(base,target),before=JSON.stringify(input),result=buildDelta(input,'base');
    assert.deepEqual(result.patch.operations,oracle(base,target));assert.deepEqual(independentlyApply(result.patch.operations,base),target);assert.equal(applyDelta(result.patch,hex(base)),hex(target));assert.equal(JSON.stringify(input),before);count++;
  }
  assert.equal(count,16129);
});
test('deterministic varied 8-bit traces include inserted, deleted and reordered runs',()=>{
  let seed=72431;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let i=0;i<600;i++){
    const base=Array.from({length:random()%80},()=>random()&255),target=[...base.slice(random()%20),...Array.from({length:random()%12},()=>random()&255),...base.slice(0,random()%20)];
    const patch=buildDelta(inputFor(base,target),'base').patch;assert.deepEqual(patch.operations,oracle(base,target));assert.deepEqual(independentlyApply(patch.operations,base),target);assert.equal(patch.target.sha256,digest(target));
  }
});
test('maximum repeated and unmatched snapshots remain bounded and reconstruct',()=>{
  for(const [base,target] of [[Array(MAX_BYTES).fill(7),Array(MAX_BYTES).fill(7)],[Array(MAX_BYTES).fill(7),Array(MAX_BYTES).fill(9)],[[],Array(MAX_BYTES).fill(0)]]){
    const result=buildDelta(inputFor(base,target),'base');assert.equal(applyDelta(result.patch,hex(base)),hex(target));assert.equal(result.copiedBytes+result.literalBytes,target.length);assert.ok(result.operationCount<=MAX_BYTES);
  }
});
test('hex is canonicalized without text decoding; all 256 byte values survive',()=>{
  const bytes=Array.from({length:256},(_,i)=>i),input=inputFor(bytes,bytes);input.targetHex=input.targetHex.toUpperCase();input.baselines[0].hex=input.baselines[0].hex.toUpperCase();
  const result=buildDelta(input,'base');assert.equal(applyDelta(result.patch,hex(bytes).toUpperCase()),hex(bytes));assert.equal(validateInput(input).targetHex,hex(bytes));
});
test('unknown and missing selections withhold all operations',()=>{
  const input=inputFor([1,2,3,4],[1,2,3,4]);assert.deepEqual(deltaPlan(input,null),{status:'incomplete',analysis:null});assert.deepEqual(deltaPlan(input,'unknown'),{status:'unknown',analysis:null});assert.throws(()=>buildDelta(input,'missing'));assert.throws(()=>deltaPlan(input,'missing'));
});
test('invalid manifests fail before Question construction',()=>{
  const good=inputFor([1,2,3,4],[1,2,3,4]);
  for(const mutate of [x=>x.targetHex='0',x=>x.targetHex='0g',x=>x.targetHex='00\n',x=>x.targetHex='00 '.repeat(2),x=>x.targetHex='00'.repeat(MAX_BYTES+1),x=>x.baselines=[],x=>x.baselines.push({...x.baselines[0],id:'other',label:'Other'}),x=>x.baselines[0].id='unknown',x=>x.baselines[0].label='Unknown',x=>x.baselines[0].extra=true,x=>x.baselines[0].hex=null,x=>x.title='\ud800',x=>x.context='trailing ',x=>x.transferId+='\n',x=>x.extra=true,x=>{x.baselines=Array(1);}]){
    const input=structuredClone(good);mutate(input);assert.throws(()=>validateInput(input));assert.throws(()=>requestFor(input,CONFIG,'baseline',id(1)));
  }
});
test('one to three options bind exact source and target hashes without sending bytes',()=>{
  const input=inputFor([1,2,3,4],[4,3,2,1]);input.baselines.push({id:'other',label:'Other base',reference:'Record B',hex:'aa'},{id:'empty',label:'Empty base',reference:'Record C',hex:''});
  const q=requestFor(input,CONFIG,'baseline',id(1));assert.equal(q.options.length,4);assert.equal(q.options.at(-1).value,'unknown');assert.equal(q.data.target_hash,digest([4,3,2,1]));assert.equal(q.data.policy_hash,POLICY_HASH);assert.equal(q.prompt.includes(input.targetHex),false);assert.equal(q.prompt.includes(input.baselines[0].hex),false);
  input.baselines[2].label=input.baselines[1].label;assert.throws(()=>validateInput(input));
});
test('wrong baseline size or same-size content never reconstructs',()=>{
  const patch=buildDelta(inputFor([1,2,3,4],[1,2,3,4]),'base').patch;assert.throws(()=>applyDelta(patch,'010203'),/Baseline/);assert.throws(()=>applyDelta(patch,'01020305'),/Baseline/);
});
test('malformed, oversized, out-of-bounds and output-expanding patches fail closed',()=>{
  const original=buildDelta(inputFor([1,2,3,4],[1,2,3,4]),'base').patch;
  for(const mutate of [p=>p.version=2,p=>p.algorithm='vcdiff',p=>p.extra=true,p=>p.baseline.bytes=-0,p=>p.target.bytes=2049,p=>p.target.sha256='0'.repeat(64),p=>p.operations=[{type:'COPY',offset:1,length:4}],p=>p.operations=[{type:'COPY',offset:-1,length:4}],p=>p.operations=[{type:'COPY',offset:-0,length:4}],p=>p.operations=[{type:'COPY',offset:0.5,length:4}],p=>p.operations=[{type:'COPY',offset:0,length:3}],p=>p.operations=[{type:'COPY',offset:0,length:4,extra:0}],p=>p.operations=[{type:'ADD',hex:'01020304'}],p=>p.operations=[{type:'LITERAL',hex:''}],p=>p.operations=[{type:'LITERAL',hex:'aA'}],p=>p.operations=[{type:'LITERAL',hex:'0102030405'}],p=>p.operations=[{type:'LITERAL',hex:'01020305'}],p=>p.operations=[],p=>p.operations=Array(1),p=>p.operations=Array(2049).fill({type:'LITERAL',hex:'00'})]){
    const patch=structuredClone(original);mutate(patch);assert.throws(()=>applyDelta(patch,'01020304'));
  }
});
test('a valid alternative encoding can verify; hashes are integrity checks, not authentication',()=>{
  const patch=buildDelta(inputFor([1,2,3,4],[1,2,3,4]),'base').patch;patch.operations=[{type:'LITERAL',hex:'01020304'}];assert.equal(applyDelta(patch,'01020304'),'01020304');assert.equal(MIN_COPY,4);
});
