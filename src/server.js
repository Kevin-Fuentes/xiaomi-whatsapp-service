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
app.use(express.json({limit:"5mb"}));

let sock=null,status="disconnected",latestQr=null,connecting=false,reconnectTimer=null;
const ensure=()=>fs.mkdir(AUTH_DIR,{recursive:true});
async function loadCfg(){try{return {...defaults,...JSON.parse(await fs.readFile(CONFIG_FILE,"utf8"))}}catch{await saveCfg(defaults);return {...defaults}}}
async function saveCfg(v){await fs.mkdir(DATA_DIR,{recursive:true});await fs.writeFile(CONFIG_FILE,JSON.stringify(v,null,2),"utf8")}
function emitStatus(v){status=v;io.emit("whatsapp-status",{status:v})}
function phone(v){let d=String(v||"").replace(/\D/g,"");if(d.length===10)d="57"+d;return d}
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
   if(u.connection==="open"){latestQr=null;connecting=false;emitStatus("connected");logger.info("WhatsApp connected")}
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

app.get("/health",(req,res)=>res.json({ok:true,status}));
app.get("/api/whatsapp/status",(req,res)=>res.json({status,qr:latestQr}));
app.post("/api/whatsapp/connect",(req,res)=>{startWA(Boolean(req.body?.force)).catch(()=>{});res.json({success:true,status,qr:latestQr})});
app.post("/api/whatsapp/disconnect",async(req,res)=>{clearTimeout(reconnectTimer);reconnectTimer=null;try{if(sock){try{await sock.logout()}catch{}try{sock.end(new Error("manual"))}catch{}}}finally{sock=null;latestQr=null;connecting=false;await clearAuth();emitStatus("disconnected")}res.json({success:true,status})});
app.get("/api/whatsapp/templates",async(req,res)=>res.json(await loadCfg()));
app.put("/api/whatsapp/templates",async(req,res)=>{const next={...(await loadCfg()),...req.body};await saveCfg(next);res.json({success:true,...next})});
app.post("/api/whatsapp/send",async(req,res)=>{try{const {phone:to,message}=req.body||{};if(!to||!message)return res.status(400).json({success:false,error:"phone y message requeridos"});res.json({success:true,phone:await sendText(to,message)})}catch(e){res.status(503).json({success:false,error:e.message})}});
app.post("/api/whatsapp/order",async(req,res)=>{try{const cfg=await loadCfg();const b=req.body||{};const vars={nombre:b.nombre,ordenNumero:b.ordenNumero,productos:b.productos,total:b.total,metodoPago:b.metodoPago,metodoEntrega:b.metodoEntrega,linea_direccion:b.linea_direccion||"",telefono:b.telefono||b.customerPhone,email:b.email||"",cedula:b.cedula||"",fecha:b.fecha||new Date().toLocaleString("es-CO")};await sendText(b.customerPhone,render(cfg.customerTemplate,vars));if(cfg.ownerPhone)await sendText(cfg.ownerPhone,render(cfg.ownerTemplate,vars));res.json({success:true})}catch(e){res.status(503).json({success:false,error:e.message})}});
app.post("/api/whatsapp/reminder",async(req,res)=>{try{const b=req.body||{};const msg=`Hola ${b.nombre||""} 👋

Te recordamos tu próxima cuota de *$${Number(b.amount||0).toLocaleString("es-CO")} COP*${b.dueDate?` con fecha *${b.dueDate}*`:""}.

Si ya realizaste el pago, puedes omitir este mensaje.

_Xiaomi Cartagena_`;await sendText(b.phone,msg);res.json({success:true})}catch(e){res.status(503).json({success:false,error:e.message})}});
io.on("connection",s=>{s.emit("whatsapp-status",{status});if(latestQr)s.emit("whatsapp-qr",{qr:latestQr})});
server.listen(PORT,"0.0.0.0",async()=>{await ensure();logger.info({PORT,ORIGINS},"server started");if(process.env.AUTO_CONNECT==="true")startWA().catch(()=>{})});

