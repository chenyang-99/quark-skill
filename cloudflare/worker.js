const REPO = "chenyang-99/quark-skill";
const SOURCE_REPO = "arcsin1/oh-my-ppt";
const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (data) => Array.from(new Uint8Array(data), b => b.toString(16).padStart(2,"0")).join("");
const unhex = (s) => new Uint8Array((s.match(/../g) || []).map(x => parseInt(x,16)));
const b64 = (data) => { const v = new Uint8Array(data); let s = ""; for(const b of v) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s.replace(/\s/g,"")), c => c.charCodeAt(0));
const json = (obj,status=200) => new Response(JSON.stringify(obj),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff"}});
const pem = (buffer) => "-----BEGIN PUBLIC KEY-----\n"+b64(buffer).match(/.{1,64}/g).join("\n")+"\n-----END PUBLIC KEY-----\n";
const importPem = async(text,kind,usages) => crypto.subtle.importKey(kind,unb64(text.replace(/-----(?:BEGIN|END) [^-]+-----/g,"")), {name:"RSA-OAEP",hash:"SHA-256"},false,usages);
const getJson = async(url,token) => { const r = await fetch(url,{headers:{"accept":"application/vnd.github+json","user-agent":"quark-cf-agent-gateway",...(token?{"authorization":"Bearer "+token}:{})}}); if(!r.ok) throw new Error("GitHub API HTTP "+r.status); return r.json(); };
const gh = (path,token) => getJson("https://api.github.com/repos/"+REPO+path,token);
const writeGh = async(path,method,body,token) => { const r=await fetch("https://api.github.com/repos/"+REPO+path,{method,headers:{"authorization":"Bearer "+token,"accept":"application/vnd.github+json","user-agent":"quark-cf-agent-gateway","content-type":"application/json"},body:JSON.stringify(body)}); if(!r.ok) throw new Error("GitHub write HTTP "+r.status); return r.json(); };
async function pack(bytes,recipient,context){
  const pub=await importPem(recipient,"spki",["encrypt"]);
  const aesBytes=crypto.getRandomValues(new Uint8Array(32)),iv=crypto.getRandomValues(new Uint8Array(12));
  const aes=await crypto.subtle.importKey("raw",aesBytes,"AES-GCM",false,["encrypt"]);
  const out=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:enc.encode(context)},aes,bytes));
  const key=await crypto.subtle.encrypt({name:"RSA-OAEP"},pub,aesBytes);
  return {version:1,algorithm:"RSA-OAEP-SHA256+AES-256-GCM",context,encrypted_key:b64(key),iv:hex(iv),tag:hex(out.slice(-16)),data:b64(out.slice(0,-16))};
}
async function unpack(envelope,privatePem,context){
  if(envelope?.version!==1||envelope.algorithm!=="RSA-OAEP-SHA256+AES-256-GCM"||envelope.context!==context)throw new Error("Invalid encrypted envelope");
  const privateKey=await importPem(privatePem,"pkcs8",["decrypt"]);
  const key=await crypto.subtle.decrypt({name:"RSA-OAEP"},privateKey,unb64(envelope.encrypted_key));
  const aes=await crypto.subtle.importKey("raw",key,"AES-GCM",false,["decrypt"]);
  const tag=unhex(envelope.tag),data=unb64(envelope.data);
  const joined=new Uint8Array(data.byteLength+tag.byteLength);joined.set(data);joined.set(tag,data.byteLength);
  const clear=await crypto.subtle.decrypt({name:"AES-GCM",iv:unhex(envelope.iv),additionalData:enc.encode(context)},aes,joined);
  return dec.decode(clear);
}
async function ticketCipher(env){
  if(!/^[a-f0-9]{64}$/i.test(env.JOB_KEY||""))throw new Error("Server job key not configured");
  return crypto.subtle.importKey("raw",unhex(env.JOB_KEY),"AES-GCM",false,["encrypt","decrypt"]);
}
async function sealTicket(ticket,env){
  const iv=crypto.getRandomValues(new Uint8Array(12)),key=await ticketCipher(env);
  const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:enc.encode("quark-cf-ticket-v1")},key,enc.encode(JSON.stringify(ticket)));
  return b64(iv)+"."+b64(cipher);
}
async function unsealTicket(value,env){
  if(typeof value!=="string"||value.length>10000||!value.includes("."))throw new Error("Invalid job ticket");
  const [iv,content]=value.split(".");
  const key=await ticketCipher(env);
  const clear=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(iv),additionalData:enc.encode("quark-cf-ticket-v1")},key,unb64(content));
  const ticket=JSON.parse(dec.decode(clear));
  if(ticket.repo!==REPO||!(/^[a-f0-9-]{36}$/i.test(ticket.id))||Date.now()-ticket.created>2*60*60*1000||ticket.created>Date.now()+60000)throw new Error("Invalid or expired ticket");
  return ticket;
}
async function submit(request,env){
  const auth=request.headers.get("authorization")||"";
  const match=/^Bearer ([^\s]{20,512})$/.exec(auth);
  if(!match)return json({error:"GitHub bearer token required; token is never stored"},401);
  const token=match[1],me=await getJson("https://api.github.com/user",token);
  if(me.login!=="chenyang-99")return json({error:"GitHub account is not the configured repository owner"},403);
  if(Number(request.headers.get("content-length")||0)>2048)return json({error:"Request too large"},413);
  const input=await request.json();
  const allowed=["windows","mac-intel","mac-apple"];
  const targets=input?.targets;
  if(!Array.isArray(targets)||!targets.length||targets.length>3||new Set(targets).size!==targets.length||targets.some(x=>!allowed.includes(x)))return json({error:"Choose unique targets from windows, mac-intel, mac-apple"},400);
  const parent=input.parent_fid;
  if(parent!==undefined && (typeof parent!=="string"||!parent||parent.length>8192||/[\x00-\x1f\x7f]/.test(parent)))return json({error:"Invalid parent_fid"},400);
  const receiver=await gh("/contents/request-public-key.pem?ref=quark-state",token);
  const publicPem=dec.decode(unb64(receiver.content));
  const id=crypto.randomUUID(), branch="quark-requests/"+id;
  const kp=await crypto.subtle.generateKey({name:"RSA-OAEP",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["encrypt","decrypt"]);
  const resultPublic=pem(await crypto.subtle.exportKey("spki",kp.publicKey));
  const privatePem="-----BEGIN PRIVATE KEY-----\n"+b64(await crypto.subtle.exportKey("pkcs8",kp.privateKey)).match(/.{1,64}/g).join("\n")+"\n-----END PRIVATE KEY-----\n";
  const payload={operation:"upload-release",request_id:id,targets,...(parent!==undefined?{parent_fid:parent}:{})};
  const envelope=await pack(enc.encode(JSON.stringify(payload)),publicPem,"request:"+REPO+":"+id);
  const commit=await gh("/git/ref/heads/main",token);
  await writeGh("/git/refs","POST",{ref:"refs/heads/"+branch,sha:commit.object.sha},token);
  try{
    const req={request_id:id,operation:"upload-release",result_public_key:resultPublic,encrypted_request:envelope};
    await writeGh("/contents/request.json","PUT",{branch,message:"Submit encrypted Quark official installer upload",content:b64(enc.encode(JSON.stringify(req)))},token);
  }catch(error){
    await fetch("https://api.github.com/repos/"+REPO+"/git/refs/heads/"+branch,{method:"DELETE",headers:{"authorization":"Bearer "+token,"user-agent":"quark-cf-agent-gateway"}}).catch(()=>{});
    throw error;
  }
  const ticket=await sealTicket({id,repo:REPO,privatePem,created:Date.now()},env);
  return json({status:"submitted",job_id:id,ticket,workflow:"https://github.com/"+REPO+"/actions",poll:"POST /v1/status"},202);
}
async function status(request,env){
  if(Number(request.headers.get("content-length")||0)>11000)return json({error:"Request too large"},413);
  const input=await request.json();
  const ticket=await unsealTicket(input.ticket,env);
  const branch="quark-requests/"+ticket.id;
  const r=await fetch("https://api.github.com/repos/"+REPO+"/contents/response.json?ref="+encodeURIComponent(branch),{headers:{"accept":"application/vnd.github+json","user-agent":"quark-cf-agent-gateway"}});
  if(r.status===404)return json({status:"pending",job_id:ticket.id},202);
  if(!r.ok)throw new Error("GitHub response HTTP "+r.status);
  const object=await r.json();
  const response=JSON.parse(dec.decode(unb64(object.content)));
  if(response.request_id!==ticket.id)throw new Error("Result request ID mismatch");
  const clear=JSON.parse(await unpack(response.encrypted_result,ticket.privatePem,"result:"+REPO+":"+ticket.id));
  const manifestFile=clear.files?.find(x=>x.name==="manifest.json");
  if(!manifestFile)throw new Error("No upload manifest returned");
  const manifest=JSON.parse(dec.decode(unb64(manifestFile.data)));
  return json({status:response.status,job_id:ticket.id,manifest,run_url:response.run_url},response.status==="complete"&&manifest.status==="complete"?200:502);
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    try{
      if(request.method==="GET" && (url.pathname==="/"||url.pathname==="/health"))return json({service:"quark-cf-upload-gateway",version:"1.0.0",mode:"Cloudflare Worker + encrypted GitHub Actions",routes:["GET /v1/release","POST /v1/upload-release","POST /v1/status"],backend:REPO});
      if(request.method==="GET"&&url.pathname==="/v1/release"){
        const authorization=request.headers.get("authorization")||"";
        const token=/^Bearer ([^\s]{20,512})$/.exec(authorization)?.[1];
        try {
          const release=await getJson("https://api.github.com/repos/"+SOURCE_REPO+"/releases/latest",token);
          return json({version:release.tag_name,assets:release.assets.filter(x=>/-win\.exe$|-mac_(x64|arm64)\.dmg$/i.test(x.name)).map(x=>({name:x.name,size:x.size,url:x.browser_download_url})),verified:true});
        } catch(error) {
          return json({version:null,assets:[],verified:false,release_page:"https://github.com/"+SOURCE_REPO+"/releases/latest",notice:"GitHub release inventory is temporarily unavailable to anonymous requests; retry with a GitHub bearer token."});
        }
      }
      if(request.method==="POST"&&url.pathname==="/v1/upload-release")return await submit(request,env);
      if(request.method==="POST"&&url.pathname==="/v1/status")return await status(request,env);
      return json({error:"Not found"},404);
    }catch(error){return json({error:"Operation failed",message:String(error.message||error).slice(0,300)},502);}
  }
};