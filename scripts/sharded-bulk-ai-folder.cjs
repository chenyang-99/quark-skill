'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const TARGET='00_教你用AI省时间+V ChenYang-Ai';
const OLD=new Set(['00_更多AI实战资料持续更新｜+V获取','00_普通人也能学AI｜+V交流','00_AI交流+V ChenYang-Ai','00_普通人也能学AI｜+V ChenYang-Ai']);
const SHARD=Number(process.env.SHARD||0),N=Number(process.env.SHARDS||4);
if(!Number.isInteger(SHARD)||SHARD<0||!Number.isInteger(N)||N<1||SHARD>=N)process.exit(3);
const CLI=path.join(process.env.QUARK_SKILL_DIR||path.join(os.homedir(),'.agents/skills/quarkclouddrive'),'scripts/quark-drive.cjs');
const PROXY=path.join(__dirname,'env-proxy.cjs');
const SESSION=String(Math.floor(Date.now()/1000))+'-'+crypto.randomBytes(3).toString('hex');
const stat={status:'running',shard:SHARD,shards:N,name:TARGET,visited:0,created:0,existing:0,browseFailures:0,createFailures:0,oldNamesSeen:0,scheduled:0,skippedConflicts:0,seedMode:null};
const seen=new Set();
const queue=[];let cursor=0,active=0,ops=0;
function checkpoint(){fs.writeFileSync('bulk-status-'+SHARD+'.json',JSON.stringify(stat)+'\n',{mode:0o600});}
function idOf(f){let id=f.fid;return String(id).includes('|')?id.slice(id.lastIndexOf('|')+1):id;}
function isdir(f){return String(f.file_type)==='0'||f.category===0;}
function hashed(fid){const d=crypto.createHash('sha256').update(String(idOf({fid}))).digest();return d.readUInt32BE(0)%N;}
function add(fid){const id=idOf({fid});if(!seen.has(id)){seen.add(id);queue.push(fid);stat.scheduled++;}}
function call(args){return new Promise((resolve,reject)=>{
 const env={...process.env};for(const key of ['GITHUB_TOKEN','QUARK_STATE_KEY','QUARK_ENCRYPTED_REQUEST','QUARK_RESULT_PUBLIC_KEY','QUARK_AUTH_CODE'])delete env[key];
 const p=spawn(process.execPath,['--require',PROXY,CLI,...args,'--session-input','在网盘现有每个文件夹内创建同名AI入门咨询文件夹','--session-id',SESSION],{env});
 let out='',killed=false;const timer=setTimeout(()=>{killed=true;p.kill('SIGKILL')},120000);
 p.stdout.on('data',b=>{out+=b.toString();if(out.length>16000000)p.kill('SIGKILL')});
 p.stderr.on('data',()=>{});
 p.on('error',()=>{clearTimeout(timer);reject(Error('spawn-error'))});
 p.on('close',code=>{
  clearTimeout(timer);if(killed)return reject(Error('timeout'));
  let rows;try{rows=out.split(/\r?\n/).filter(Boolean).map(JSON.parse)}catch{return reject(Error('invalid-output'))}
  const result=rows.findLast(x=>x.type==='result');
  if(code!==0||!result||result.code!==0)return reject(Error('code-'+(result?.code??'missing')));
  resolve({rows,result});
 });
});}
function pause(ms){return new Promise(r=>setTimeout(r,ms));}
async function retry(fn){
 let last;
 for(let a=0;a<5;a++){
  try{return await fn()}catch(e){last=e;if(a<4)await pause((a+1)*(a+1)*1200+SHARD*250);}
 }
 throw last;
}
async function browse(fid){
 return retry(async()=>{
  const {rows,result}=await call(['browse','--parent-fid',fid,'--all']);
  if(result.data?.hasMore)throw Error('has-more');
  const record=rows.findLast(x=>x.type==='artifact'&&x.action==='browse');
  if(!record?.data?.file_path)throw Error('missing-artifact');
  return fs.readFileSync(record.data.file_path,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
 });
}
function children(items){
 const ids=new Set(),out=[];
 for(const item of items){
  if(!item||typeof item.fid!=='string'||typeof item.filename!=='string'||!isdir(item)||item.filename===TARGET||OLD.has(item.filename))continue;
  const id=idOf(item);if(!ids.has(id)){ids.add(id);out.push(item)}
 }
 return out;
}
async function ensure(fid,items){
 const exists=items.find(x=>x.filename===TARGET);
 if(exists){
  if(isdir(exists))stat.existing++;
  else stat.skippedConflicts++;
  return;
 }
 try{await retry(()=>call(['create-folder','--dir-path',TARGET,'--parent-fid',fid]));stat.created++;}
 catch(e){stat.createFailures++;stat.lastCreateError=String(e.message).slice(0,70);}
}
async function processOne(fid,{create=true,enqueue=true}={}){
 let arr;try{arr=await browse(fid)}catch(e){stat.browseFailures++;stat.lastBrowseError=String(e.message).slice(0,70);return [];}
 stat.visited++;
 stat.oldNamesSeen+=arr.filter(x=>isdir(x)&&OLD.has(x.filename)).length;
 if(create)await ensure(fid,arr);
 const dirs=children(arr);if(enqueue)for(const f of dirs)add(f.fid);
 ops++;if(ops%50===0){checkpoint();console.log('progress '+JSON.stringify({shard:SHARD,visited:stat.visited,created:stat.created,scheduled:stat.scheduled,errors:stat.createFailures+stat.browseFailures}));}
 return dirs;
}
async function worker(){
 for(;;){
  if(cursor>=queue.length){if(active===0)return;await pause(150);continue;}
  let idx=cursor++;let fid=queue[idx];active++;
  await processOne(fid);
  active--;if(stat.visited%30===0)checkpoint();
 }
}
async function main(){
 checkpoint();
 const root=await processOne('0',{create:SHARD===0,enqueue:false});
 if(stat.browseFailures)throw Error('root-browse-failed');
 if(root.length>=12){
  stat.seedMode='level1';
  for(const f of root)if(hashed(f.fid)===SHARD)add(f.fid);
 } else {
  stat.seedMode='level2';
  for(const f of root) {
   const children2=await processOne(f.fid,{create:SHARD===0,enqueue:false});
   for(const c of children2)if(hashed(c.fid)===SHARD)add(c.fid);
  }
 }
 checkpoint();
 await Promise.all([worker(),worker(),worker()]);
 stat.status=stat.createFailures||stat.browseFailures||stat.skippedConflicts?'partial':'complete';
 checkpoint();
 console.log('FINAL '+JSON.stringify(stat));
 if(stat.status!=='complete')process.exitCode=2;
}
main().catch(e=>{stat.status='failed';stat.lastFatalError=String(e.message).slice(0,80);checkpoint();console.log('FINAL '+JSON.stringify(stat));process.exitCode=1;});
