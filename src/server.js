import express from "express";
import cors from "cors";
import http from "http";
import {Server as SocketIOServer} from "socket.io";
import QRCode from "qrcode";
import pino from "pino";
import fs from "fs/promises";
import path from "path";
import {makeWASocket,useMultiFileAuthState,fetchLatestBaileysVersion,DisconnectReason,Browsers} from "@whiskeysockets/baileys";

const PORT=Number(process.env.PORT||3000);
const DATA_DIR=process.env.DATA_DIR||"/data";
const AUTH_DIR=path.join(DATA_DIR,"auth");
const CONFIG_FILE=path.join(DATA_DIR,"templates.json");
const CAMPAIGNS_FILE=path.join(DATA_DIR,"campaigns.json");
const POS_QUEUE_FILE=path.join(DATA_DIR,"pos-message-queue.json");
const POS_DELAY_MS=Number(process.env.POS_MESSAGE_DELAY_MS||600000);
const OLD_BACKEND_URL=process.env.OLD_BACKEND_URL||"https://xiaomictg-backend-production.up.railway.app";
const ORIGINS=(process.env.ALLOWED_ORIGINS||"https://xiaomicartagena.com,https://www.xiaomicartagena.com").split(",").map(x=>x.trim()).filter(Boolean);
const logger=pino({level:process.env.LOG_LEVEL||"info"});

const defaults={
 customerTemplate:`🎉 *¡Pedido Confirmado!* — Xiaomi Cartagena

Hola *{{nombre}}*, gracias por tu compra. 🧡

🔖 *Orden:* #{{ordenNumero}}

🛍️ *Tus productos:*
{{productos}}

💰 *Total:* \${{total}} COP
💳 *Pago:* {{metodoPago}}
🚚 *Entrega:* {{metodoEntrega}}
{{linea_direccion}}
⏱️ En breve nuestro equipo se contactará contigo.

_Xiaomi Cartagena — Cl. 31 #61-64, Los Ángeles_`,
 ownerTemplate:`🔔 *NUEVA VENTA* 🎯 — Xiaomi Cartagena

👤 *Cliente:* {{nombre}}
📞 *Cel:* {{telefono}}
📧 *Email:* {{email}}
🪪 *Cédula:* {{cedula}}

🔖 *Orden:* #{{ordenNumero}}

🛍️ *Productos:*
{{productos}}

💰 *Total:* \${{total}} COP
💳 *Pago:* {{metodoPago}}
🚚 *Entrega:* {{metodoEntrega}}
{{linea_direccion}}
📅 {{fecha}}

_Xiaomi Cartagena_`,
 inStoreTemplate:`🎉 *¡Gracias por tu compra!* — Xiaomi Cartagena

Hola *{{nombre}}*, gracias por visitarnos en nuestra tienda física. 🧡

🛍️ *Tu compra:*
• {{producto}}

💰 *Total:* \${{total}} COP
💳 *Método de pago:* {{metodoPago}}
📄 *Facturado a:* {{cedula}}

_Xiaomi Cartagena — Cl. 31 #61-64, Los Ángeles_`,
 ownerPhone:"3147729229"
};

const app=express();
const server=http.createServer(app);
const io=new SocketIOServer(server,{cors:{origin:ORIGINS}});
app.use(cors({origin:(origin,cb)=>!origin||ORIGINS.includes(origin)?cb(null,true):cb(new Error("CORS"))}));
app.use(express.json({limit:"8mb"}));

let sock=null,status="disconnected",latestQr=null,connecting=false,reconnectTimer=null;
const campaignTimers=new Map();
const posTimers=new Map();

const ensure=()=>fs.mkdir(AUTH_DIR,{recursive:true});
async function readJson(file,fallback){try{return JSON.parse(await fs.readFile(file,"utf8"))}catch{return fallback}}
async function writeJson(file,value){await fs.mkdir(DATA_DIR,{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2),"utf8")}
async function loadCfg(){const cfg=await readJson(CONFIG_FILE,null);if(cfg)return{...defaults,...cfg};await saveCfg(defaults);return{...defaults}}
async function saveCfg(v){await writeJson(CONFIG_FILE,v)}
async function loadCampaigns(){return await readJson(CAMPAIGNS_FILE,[])}
async function saveCampaigns(v){await writeJson(CAMPAIGNS_FILE,v)}
async function loadPosQueue(){return await readJson(POS_QUEUE_FILE,[])}
async function savePosQueue(v){await writeJson(POS_QUEUE_FILE,v)}
async function updatePosJob(id,mutator){const all=await loadPosQueue(),ix=all.findIndex(x=>x.id===id);if(ix<0)return null;mutator(all[ix]);await savePosQueue(all);return all[ix]}
async function runPosJob(id){
 posTimers.delete(id);const all=await loadPosQueue(),job=all.find(x=>x.id===id);
 if(!job||["sent","cancelled"].includes(job.status))return;
 if(status!=="connected"){await updatePosJob(id,x=>{x.status="pending";x.lastError="WhatsApp no está conectado"});return}
 try{const cfg=await loadCfg();await sendText(job.telefono,render(cfg.inStoreTemplate,job.vars));await updatePosJob(id,x=>{x.status="sent";x.sentAt=new Date().toISOString();x.lastError=""})}
 catch(e){await updatePosJob(id,x=>{x.status="pending";x.lastError=e.message||String(e)});logger.error({err:e,posJob:id},"POS delayed message failed")}
}
async function schedulePosJob(job){
 if(posTimers.has(job.id)){clearTimeout(posTimers.get(job.id));posTimers.delete(job.id)}
 if(["sent","cancelled"].includes(job.status))return;
 const wait=Math.max(0,new Date(job.sendAt).getTime()-Date.now());
 posTimers.set(job.id,setTimeout(()=>runPosJob(job.id).catch(e=>logger.error({err:e,posJob:job.id},"POS job")),wait))
}
async function resumePosJobs(){for(const job of await loadPosQueue())if(!["sent","cancelled"].includes(job.status))await schedulePosJob(job)}
function emitStatus(v){status=v;io.emit("whatsapp-status",{status:v})}
function phone(v){let d=String(v||"").replace(/\D/g,"");if(!d)return"";if(d.startsWith("57")&&d.length===12)return d;if(d.length===10)return"57"+d;return d}
function render(t,vars){let out=String(t||"");for(const[k,v]of Object.entries(vars||{})){out=out.split(`{{${k}}}`).join(String(v??""));out=out.split(`{{ ${k} }}`).join(String(v??""))}return out}
async function clearAuth(){await fs.rm(AUTH_DIR,{recursive:true,force:true});await ensure()}
async function startWA(force=false){
 if(connecting&&!force)return;
 connecting=true;latestQr=null;emitStatus("loading");
 try{
  await ensure();
  if(force&&sock){try{sock.end(new Error("force"))}catch{} sock=null}
  const {state,saveCreds}=await useMultiFileAuthState(AUTH_DIR);
  const {version}=await fetchLatestBaileysVersion();
  sock=makeWASocket({version,auth:state,logger,browser:Browsers.ubuntu("Chrome"),printQRInTerminal:false,markOnlineOnConnect:false,syncFullHistory:false,generateHighQualityLinkPreview:false});
  sock.ev.on("creds.update",saveCreds);
  sock.ev.on("connection.update",async u=>{
   if(u.qr){latestQr=await QRCode.toDataURL(u.qr,{margin:1,width:320});connecting=false;emitStatus("qr_ready");io.emit("whatsapp-qr",{qr:latestQr})}
   if(u.connection==="open"){latestQr=null;connecting=false;emitStatus("connected");logger.info("WhatsApp connected");resumeScheduledCampaigns().catch(e=>logger.error({err:e},"resume campaigns"));resumePosJobs().catch(e=>logger.error({err:e},"resume POS messages"))}
   if(u.connection==="close"){
    connecting=false;
    const code=u.lastDisconnect?.error?.output?.statusCode;
    logger.warn({code,error:u.lastDisconnect?.error?.message},"WhatsApp closed");
    if(code===DisconnectReason.loggedOut){latestQr=null;emitStatus("disconnected");await clearAuth();return}
    emitStatus("loading");clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>startWA(true).catch(()=>{}),3000);
   }
  });
 }catch(e){connecting=false;logger.error({err:e},"startWA failed");emitStatus("disconnected")}
}
async function sendText(to,text){
 if(!sock||status!=="connected")throw new Error("WhatsApp no está conectado");
 const p=phone(to);if(!p)throw new Error("Número inválido");
 await sock.sendMessage(`${p}@s.whatsapp.net`,{text});return p;
}
async function sendImageOrText(to,message,imageUrl){
 const p=phone(to); if(!p)throw new Error("Número inválido");
 if(!sock||status!=="connected")throw new Error("WhatsApp no está conectado");
 const jid=`${p}@s.whatsapp.net`;
 if(imageUrl){
  if(imageUrl.startsWith("data:image/")){
   const m=imageUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
   if(m){await sock.sendMessage(jid,{image:Buffer.from(m[2],"base64"),mimetype:m[1],caption:message});return p}
  }
  if(/^https?:\/\//i.test(imageUrl)){await sock.sendMessage(jid,{image:{url:imageUrl},caption:message});return p}
 }
 await sock.sendMessage(jid,{text:message});return p;
}

async function fetchCustomers(){
 const map=new Map();
 try{
  const [ordersRes,finRes,posRes]=await Promise.allSettled([
   fetch(`${OLD_BACKEND_URL}/api/orders`),
   fetch(`${OLD_BACKEND_URL}/api/financing`),
   fetch(`${OLD_BACKEND_URL}/api/inventario/ventas`)
  ]);
  if(ordersRes.status==="fulfilled"&&ordersRes.value.ok){
   const raw=await ordersRes.value.json(); const orders=Array.isArray(raw)?raw:(raw.orders||raw.data||[]);
   for(const o of orders){
    const c=o.customerInfo||o.customer||{};
    const p=phone(c.phone||o.phone); if(!p)continue;
    map.set(p,{name:c.name||o.customerName||"Cliente",phone:p,lastPurchaseDate:o.createdAt||o.date||null,lastPurchaseProduct:(o.items?.[0]?.product?.name||o.items?.[0]?.name||"Pedido web")});
   }
  }
  if(finRes.status==="fulfilled"&&finRes.value.ok){
   const raw=await finRes.value.json(); const rows=Array.isArray(raw)?raw:(raw.data||[]);
   for(const c of rows){
    const p=phone(c.telefono||c.phone); if(!p)continue;
    map.set(p,{name:c.nombre||c.customer_name||"Cliente",phone:p,lastPurchaseDate:c.createdAt||c.created_at||null,lastPurchaseProduct:c.producto||"Crédito"});
   }
  }
  if(posRes.status==="fulfilled"&&posRes.value.ok){
   const raw=await posRes.value.json(); const rows=Array.isArray(raw)?raw:(raw.ventas||raw.data||[]);
   for(const c of rows){
    const p=phone(c.telefono||c.phone);if(!p)continue;
    map.set(p,{name:c.cliente||c.nombre||"Cliente",phone:p,lastPurchaseDate:c.fecha||c.createdAt||c.created_at||null,lastPurchaseProduct:c.producto||"Compra en tienda"});
   }
  }
 }catch(e){logger.warn({err:e},"fetchCustomers")}
 return [...map.values()];
}

function campaignDelay(ms){return new Promise(r=>setTimeout(r,ms))}
async function updateCampaign(id,mutator){
 const all=await loadCampaigns();const ix=all.findIndex(c=>c.id===id);if(ix<0)return null;
 mutator(all[ix]);await saveCampaigns(all);return all[ix];
}
async function runCampaign(id){
 campaignTimers.delete(id);
 let all=await loadCampaigns();let c=all.find(x=>x.id===id);if(!c||["sent","cancelled"].includes(c.status))return;
 if(status!=="connected"){await updateCampaign(id,x=>x.status="paused");return}
 await updateCampaign(id,x=>x.status="processing");
 for(let i=0;i<c.recipients.length;i++){
  all=await loadCampaigns();c=all.find(x=>x.id===id);if(!c||c.status==="paused"||c.status==="cancelled")return;
  const r=c.recipients[i];
  if(r.status==="sent")continue;
  try{
   const msg=render(c.message,{"nombre":r.name||"Cliente","telefono":r.phone||""});
   await sendImageOrText(r.phone,msg,c.imageUrl||"");
   await updateCampaign(id,x=>{const rr=x.recipients[i];rr.status="sent";rr.processedAt=new Date().toISOString();rr.error="";x.sentCount=x.recipients.filter(q=>q.status==="sent").length;x.failedCount=x.recipients.filter(q=>q.status==="failed").length});
  }catch(e){
   await updateCampaign(id,x=>{const rr=x.recipients[i];rr.status="failed";rr.processedAt=new Date().toISOString();rr.error=e.message;x.failedCount=x.recipients.filter(q=>q.status==="failed").length});
  }
  if(i<c.recipients.length-1)await campaignDelay(Math.max(1,Number(c.delaySeconds||10))*1000);
 }
 await updateCampaign(id,x=>x.status="sent");
}
async function scheduleCampaign(c){
 if(campaignTimers.has(c.id)){clearTimeout(campaignTimers.get(c.id));campaignTimers.delete(c.id)}
 if(c.status==="scheduled"&&c.scheduledAt){
  const wait=Math.max(0,new Date(c.scheduledAt).getTime()-Date.now());
  const timer=setTimeout(()=>runCampaign(c.id).catch(e=>logger.error({err:e,campaign:c.id},"campaign")),wait);
  campaignTimers.set(c.id,timer);
 }else if(c.status==="active"||c.status==="processing"){
  const timer=setTimeout(()=>runCampaign(c.id).catch(e=>logger.error({err:e,campaign:c.id},"campaign")),100);
  campaignTimers.set(c.id,timer);
 }
}
async function resumeScheduledCampaigns(){for(const c of await loadCampaigns())if(["scheduled","active","processing"].includes(c.status))await scheduleCampaign(c)}

app.get("/health",(req,res)=>res.json({ok:true,service:"xiaomi-whatsapp-service",status}));
app.get("/api/whatsapp/status",(req,res)=>res.json({status,qr:latestQr}));
app.post("/api/whatsapp/connect",(req,res)=>{startWA(Boolean(req.body?.force)).catch(()=>{});res.json({success:true,status,qr:latestQr})});
app.post("/api/whatsapp/disconnect",async(req,res)=>{clearTimeout(reconnectTimer);reconnectTimer=null;try{if(sock){try{await sock.logout()}catch{}try{sock.end(new Error("manual"))}catch{}}}finally{sock=null;latestQr=null;connecting=false;await clearAuth();emitStatus("disconnected")}res.json({success:true,status})});

app.get("/api/whatsapp/templates",async(req,res)=>res.json(await loadCfg()));
app.put("/api/whatsapp/templates",async(req,res)=>{const next={...(await loadCfg()),...req.body};await saveCfg(next);res.json({success:true,...next})});

app.post("/api/whatsapp/send",async(req,res)=>{try{const {phone:to,message,imageUrl}=req.body||{};if(!to||!message)return res.status(400).json({success:false,error:"phone y message requeridos"});res.json({success:true,phone:await sendImageOrText(to,message,imageUrl||"")})}catch(e){res.status(503).json({success:false,error:e.message})}});

app.post("/api/whatsapp/order",async(req,res)=>{try{
 const cfg=await loadCfg(),b=req.body||{};
 if(!b.customerPhone)return res.status(400).json({success:false,error:"customerPhone requerido"});
 const vars={nombre:b.nombre||"Cliente",ordenNumero:b.ordenNumero||"",productos:b.productos||"",producto:b.producto||b.productos||"",total:b.total||"",metodoPago:b.metodoPago||"",metodoEntrega:b.metodoEntrega||"",linea_direccion:b.linea_direccion||"",telefono:b.telefono||b.customerPhone,email:b.email||"",cedula:b.cedula||"",fecha:b.fecha||new Date().toLocaleString("es-CO")};
 await sendText(b.customerPhone,render(cfg.customerTemplate,vars));
 if(cfg.ownerPhone)await sendText(cfg.ownerPhone,render(cfg.ownerTemplate,vars));
 res.json({success:true,sent:["customer",...(cfg.ownerPhone?["owner"]:[])]});
}catch(e){res.status(503).json({success:false,error:e.message})}});

app.post("/api/whatsapp/in-store",async(req,res)=>{try{
 const cfg=await loadCfg(),b=req.body||{};
 const vars={nombre:b.nombre||"Cliente",ordenNumero:b.ordenNumero||"",productos:b.producto||"",producto:b.producto||"",total:b.total||"",metodoPago:b.metodoPago||"",metodoEntrega:"Tienda física",linea_direccion:"",telefono:b.telefono||"",email:b.email||"",cedula:b.cedula||"",fecha:b.fecha||new Date().toLocaleString("es-CO"),puntosGanados:Number(b.puntosGanados||0).toLocaleString("es-CO"),puntosBalance:Number(b.puntosBalance||0).toLocaleString("es-CO")};
 const result={success:true,ownerSent:false,customerScheduled:false};
 if(cfg.ownerPhone){await sendText(cfg.ownerPhone,render(cfg.ownerTemplate,vars));result.ownerSent=true}
 if(b.telefono){
  const now=Date.now(),job={id:`POS-${now}-${Math.random().toString(36).slice(2,8)}`,telefono:b.telefono,vars,createdAt:new Date(now).toISOString(),sendAt:new Date(now+POS_DELAY_MS).toISOString(),status:"pending",sentAt:null,lastError:""};
  const queue=await loadPosQueue();queue.push(job);await savePosQueue(queue);await schedulePosJob(job);
  result.customerScheduled=true;result.sendAt=job.sendAt;result.delayMinutes=Math.round(POS_DELAY_MS/60000)
 }
 res.json(result);
}catch(e){res.status(503).json({success:false,error:e.message})}});

app.post("/api/whatsapp/owner-alert",async(req,res)=>{try{
 const cfg=await loadCfg(),b=req.body||{};if(!cfg.ownerPhone)return res.status(400).json({success:false,error:"ownerPhone no configurado"});
 await sendText(cfg.ownerPhone,render(cfg.ownerTemplate,b));res.json({success:true});
}catch(e){res.status(503).json({success:false,error:e.message})}});

app.post("/api/whatsapp/reminder",async(req,res)=>{try{
 const b=req.body||{};if(!b.phone||!b.amount)return res.status(400).json({success:false,error:"phone y amount requeridos"});
 const msg=`Hola ${b.nombre||""} 👋

Te recordamos tu próxima cuota de *$${Number(b.amount||0).toLocaleString("es-CO")} COP*${b.dueDate?` con fecha *${b.dueDate}*`:""}.

Si ya realizaste el pago, puedes omitir este mensaje.

_Xiaomi Cartagena_`;
 await sendText(b.phone,msg);res.json({success:true});
}catch(e){res.status(503).json({success:false,error:e.message})}});

app.get("/api/whatsapp/customers",async(req,res)=>{res.json(await fetchCustomers())});
app.get("/api/whatsapp/pos-queue",async(req,res)=>{const q=await loadPosQueue();res.json(q.slice().reverse())});
app.get("/api/whatsapp/campaigns",async(req,res)=>res.json(await loadCampaigns()));
app.post("/api/whatsapp/campaigns",async(req,res)=>{try{
 const b=req.body||{};if(!b.name||!b.message||!Array.isArray(b.recipients)||!b.recipients.length)return res.status(400).json({error:"name, message y recipients requeridos"});
 const all=await loadCampaigns(),now=new Date().toISOString();
 const c={id:`CAMP-${Date.now()}`,name:b.name,message:b.message,imageUrl:b.imageUrl||"",scheduledAt:b.scheduledAt||null,delaySeconds:Math.max(1,Number(b.delaySeconds||10)),recipients:b.recipients.map(r=>({name:r.name||"Cliente",phone:phone(r.phone),status:"pending",processedAt:null,error:""})),totalRecipients:b.recipients.length,sentCount:0,failedCount:0,status:b.scheduledAt?"scheduled":"paused",createdAt:now};
 all.unshift(c);await saveCampaigns(all);if(c.status==="scheduled")await scheduleCampaign(c);res.json(c);
}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/whatsapp/campaigns/:id/status",async(req,res)=>{try{
 const wanted=req.body?.status||"paused";const c=await updateCampaign(req.params.id,x=>x.status=wanted);if(!c)return res.status(404).json({error:"Campaña no encontrada"});
 if(["active","processing","scheduled"].includes(wanted))await scheduleCampaign(c);else if(campaignTimers.has(c.id)){clearTimeout(campaignTimers.get(c.id));campaignTimers.delete(c.id)}
 res.json(c);
}catch(e){res.status(500).json({error:e.message})}});
app.delete("/api/whatsapp/campaigns/:id",async(req,res)=>{const all=await loadCampaigns(),next=all.filter(c=>c.id!==req.params.id);if(next.length===all.length)return res.status(404).json({error:"Campaña no encontrada"});if(campaignTimers.has(req.params.id)){clearTimeout(campaignTimers.get(req.params.id));campaignTimers.delete(req.params.id)}await saveCampaigns(next);res.json({success:true})});

io.on("connection",s=>{s.emit("whatsapp-status",{status});if(latestQr)s.emit("whatsapp-qr",{qr:latestQr})});
server.listen(PORT,"0.0.0.0",async()=>{await ensure();logger.info({PORT,ORIGINS,OLD_BACKEND_URL},"server started");await resumeScheduledCampaigns();await resumePosJobs();if(process.env.AUTO_CONNECT==="true")startWA().catch(()=>{})});
