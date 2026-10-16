'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const TARGET='00_AI交流+V ChenYang-Ai';
const LEGACY_NAMES=new Set(['00_更多AI实战资料持续更新｜+V获取','00_普通人也能学AI｜+V交流','00_普通人也能学AI｜+V ChenYang-Ai']);
const SKILL=process.env.QUARK_SKILL_DIR||path.join(os.homedir(),'.agents/skills/quarkclouddrive');
const CLI=path.join(SKILL,'scripts/quark-drive.cjs');
const PROXY=path.join(__dirname,'env-proxy.cjs');
const SESSION=String(Math.floor(Date.now()/1000))+'-'+crypto.randomBytes(3).toString('hex');
const INPUT='这是一个批量任务，你必须以最快的速度完成，可使用多agent。用我github中的夸克skill和百度skill把我所有文件目录下都新建一个新的文件夹，文件夹命名为我也不知道命名为什么，我想吸引我闲鱼的客户来私域，主要是AI方面的，你觉得应该怎么命名？还要写+V';
const stat={status:'running',name:TARGET,foldersVisited:0,foldersCreated:0,foldersExisting:0,folderNameConflicts:0,browseFailures:0,createFailures:0,queued:1,previousNameFoldersSeen:0};
const visited=new Set(['0']), queue=['0'];let cursor=0,active=0;
function checkpoint(){fs.writeFileSync('bulk-folder-status.json',JSON.stringify(stat)+'\n',{mode:0o600});}
function cmd(args){return new Promise((resolve,reject)=>{
 const env={...process.env};for(const x of ['GITHUB_TOKEN','QUARK_STATE_KEY','QUARK_ENCRYPTED_REQUEST','QUARK_RESULT_PUBLIC_KEY','QUARK_AUTH_CODE'])delete env[x];
 const p=spawn(process.execPath,['--require',PROXY,CLI,...args,'--session-input',INPUT,'--session-id',SESSION],{env});
 let out='',over=false;
 const timer=setTimeout(()=>{over=true;p.kill('SIGKILL');},180000);
 p.stdout.on('data',b=>{out+=b.toString();if(out.length>8000000)p.kill('SIGKILL');});
 p.stderr.on('data',()=>{});
 p.on('error',()=>{clearTimeout(timer);reject(new Error('CLI error'));});
 p.on('close',code=>{clearTimeout(timer);if(over)return reject(Error('CLI timed out'));
  let lines;try{lines=out.split(/\r?\n/).filter(Boolean).map(JSON.parse);}catch{return reject(Error('CLI parse failed'));}
  const r=lines.findLast(x=>x.type==='result');
  if(code!==0||!r||r.code!==0)return reject(Error('CLI code '+String(r?.code??'missing')));
  resolve({lines,result:r});
 });
});}
function isdir(f){return String(f.file_type)==='0'||f.category===0;}
async function contents(fid){
 const {lines,result}=await cmd(['browse','--parent-fid',fid,'--all']);
 if(result.data?.hasMore)throw Error('Incomplete listing');
 const artifact=lines.findLast(x=>x.type==='artifact'&&x.action==='browse');
 if(!artifact?.data?.file_path)throw Error('Missing full listing');
 return fs.readFileSync(artifact.data.file_path,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
async function worker(){for(;;){
 if(cursor>=queue.length){if(active===0)return;await new Promise(ok=>setTimeout(ok,200));continue;}
 const i=cursor++;active++;const fid=queue[i];
 let arr;try{arr=await contents(fid);}catch(e){stat.browseFailures++;stat.lastBrowseError=String(e.message).slice(0,120);active--;checkpoint();continue;}
 stat.foldersVisited++;
 let exists=false,conflict=false;
 for(const f of arr){
  if(typeof f.filename!=='string'||typeof f.fid!=='string')continue;
  if(f.filename===TARGET){if(isdir(f))exists=true;else conflict=true;continue;}
  if(LEGACY_NAMES.has(f.filename)&&isdir(f)){stat.previousNameFoldersSeen++;continue;}
  if(isdir(f)){const key=f.fid.includes('|')?f.fid.slice(f.fid.lastIndexOf('|')+1):f.fid;
   if(!visited.has(key)){visited.add(key);queue.push(f.fid);stat.queued++;}
  }
 }
 if(exists)stat.foldersExisting++;
 else if(conflict)stat.folderNameConflicts++;
 else {try{await cmd(['create-folder','--dir-path',TARGET,'--parent-fid',fid]);stat.foldersCreated++;}
 catch{stat.createFailures++;}}
 active--;checkpoint();
}}
async function main(){checkpoint();await Promise.all([worker(),worker(),worker(),worker()]);
 stat.status=stat.browseFailures||stat.createFailures||stat.folderNameConflicts?'partial':'complete';checkpoint();
 console.log(JSON.stringify({status:stat.status,created:stat.foldersCreated,existing:stat.foldersExisting,visited:stat.foldersVisited,failures:stat.browseFailures+stat.createFailures+stat.folderNameConflicts}));
 if(stat.status!=='complete')process.exitCode=2;
}
main().catch(()=>{stat.status='failed';checkpoint();process.exitCode=1;});
