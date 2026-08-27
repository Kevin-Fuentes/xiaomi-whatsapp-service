import express from "express";
import cors from "cors";
import http from "http";
import {Server as SocketIOServer} from "socket.io";
import pino from "pino";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {chromium} from "playwright";
import QRCode from "qrcode";

const PORT=Number(process.env.PORT||3000);
const DATA_DIR=process.env.DATA_DIR||"/data";
const PROFILE_DIR=path.join(DATA_DIR,"whatsapp-profile");
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

let context=null,page=null,status="disconnected",latestQr=null,connecting=false;
let monitorTimer=null,lastPairingAt=null,lastDisconnectInfo=null,lastBrowserInfo=null;
let sendChain=Promise.resolve();
const campaignTimers=new Map();
const posTimers=new Map();

const ensure=()=>fs.mkdir(PROFILE_DIR,{recursive:true});
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

async function profileHasData(){
 try{const files=await fs.readdir(PROFILE_DIR);return files.length>0}catch{return false}
}

async function closeBrowser(reason="close"){
 clearInterval(monitorTimer);monitorTimer=null;
 try{await context?.close()}catch(e){logger.warn({err:e?.message||String(e),reason},"Browser close warning")}
 context=null;page=null;connecting=false;latestQr=null;
}

async function clearProfile(){
 await closeBrowser("clear-profile");
 await fs.rm(PROFILE_DIR,{recursive:true,force:true});
 await ensure();
}

async function findQrLocator() {
  if (!page || page.isClosed()) return null;

  // 1. Canvas tradicional
  const canvas = page.locator("canvas").filter({
    has: page.locator("xpath=..")
  });

  const canvasCount = await page.locator("canvas").count().catch(() => 0);

  for (let i = 0; i < canvasCount; i++) {
    const loc = page.locator("canvas").nth(i);
    const box = await loc.boundingBox().catch(() => null);

    if (
      box &&
      box.width >= 180 &&
      box.height >= 180 &&
      Math.abs(box.width - box.height) < 100
    ) {
      return loc;
    }
  }

  // 2. QR moderno basado en SVG
  const svgCount = await page.locator("svg").count().catch(() => 0);

  for (let i = 0; i < svgCount; i++) {
    const loc = page.locator("svg").nth(i);
    const box = await loc.boundingBox().catch(() => null);

    if (
      box &&
      box.width >= 180 &&
      box.height >= 180 &&
      Math.abs(box.width - box.height) < 100
    ) {
      return loc;
    }
  }

  // 3. Contenedor usado por WhatsApp
  const dataRef = page.locator("[data-ref]").first();

  if (await dataRef.count().catch(() => 0)) {
    const box = await dataRef.boundingBox().catch(() => null);

    if (box && box.width >= 180 && box.height >= 180) {
      return dataRef;
    }
  }

  return null;
}

async function isConnectedUi() {
  if (!page || page.isClosed()) return false;

  const selectors = [
    "#pane-side",
    "#main",
    '[data-testid="chat-list"]',
    'div[aria-label*="Chat list"]',
    'div[aria-label*="Lista de chats"]',
    '[role="grid"]'
  ];

  for (const sel of selectors) {
    const count = await page.locator(sel).count().catch(() => 0);

    if (count > 0) {
      return true;
    }
  }

  return false;
}
async function refreshState() {
  if (!page || page.isClosed()) return;

  try {
    // 1. Detectar claramente la interfaz conectada
    if (await isConnectedUi()) {
      if (status !== "connected") {
        latestQr = null;
        connecting = false;
        lastDisconnectInfo = null;

        emitStatus("connected");

        logger.info("WhatsApp Web connected in Chromium");

        resumeScheduledCampaigns().catch(e =>
          logger.error({ err: e }, "resume campaigns")
        );

        resumePosJobs().catch(e =>
          logger.error({ err: e }, "resume POS messages")
        );
      }

      return;
    }

    // 2. Buscar data-ref ORIGINAL del QR
    const qrRef = await page
      .locator("[data-ref]")
      .first()
      .getAttribute("data-ref")
      .catch(() => null);

    if (qrRef && qrRef.length > 50) {
      const next = await QRCode.toDataURL(qrRef, {
        width: 420,
        margin: 4,
        errorCorrectionLevel: "M"
      });

      const changed = next !== latestQr;

      latestQr = next;
      connecting = false;

      if (status !== "qr_ready" || changed) {
        lastPairingAt = new Date().toISOString();

        emitStatus("qr_ready");

        io.emit("whatsapp-qr", {
          qr: latestQr
        });

        logger.info("WhatsApp QR generated directly from data-ref");
      }

      return;
    }

    // 3. Detectar EXPLÍCITAMENTE pantalla de login
    const bodyText = await page.locator("body")
      .innerText()
      .catch(() => "");

    const loginScreen =
      bodyText.includes("Escanea para iniciar sesión") ||
      bodyText.includes("Escanea el código QR") ||
      bodyText.includes("Scan QR code") ||
      bodyText.includes("Link with phone number") ||
      bodyText.includes("Vincular con el número de teléfono");

    // Si ya estaba conectado y NO vemos pantalla de login,
    // NO cambiar a loading por un cambio temporal del DOM.
    if (status === "connected" && !loginScreen) {
      return;
    }

    // 4. Fallback visual para encontrar QR
    const qr = await findQrLocator();

    if (qr) {
      let next = null;

      next = await qr.evaluate((el) => {
        if (el instanceof HTMLCanvasElement) {
          return el.toDataURL("image/png");
        }

        const canvas = el.querySelector?.("canvas");

        if (canvas instanceof HTMLCanvasElement) {
          return canvas.toDataURL("image/png");
        }

        return null;
      }).catch(() => null);

      if (!next) {
        next = await qr.evaluate((el) => {
          let svg = null;

          if (
            el instanceof SVGElement ||
            el.tagName?.toLowerCase() === "svg"
          ) {
            svg = el;
          } else {
            svg = el.querySelector?.("svg");
          }

          if (!svg) return null;

          const xml = new XMLSerializer().serializeToString(svg);

          return (
            "data:image/svg+xml;base64," +
            btoa(unescape(encodeURIComponent(xml)))
          );
        }).catch(() => null);
      }

      if (!next) {
        const buf = await qr.screenshot({
          type: "png",
          animations: "disabled"
        });

        next = `data:image/png;base64,${buf.toString("base64")}`;
      }

      const changed = next !== latestQr;

      latestQr = next;
      connecting = false;

      if (status !== "qr_ready" || changed) {
        lastPairingAt = new Date().toISOString();

        emitStatus("qr_ready");

        io.emit("whatsapp-qr", {
          qr: latestQr
        });
      }

      return;
    }

    // 5. Solo usar loading durante una conexión REAL en progreso.
    // Nunca degradar connected simplemente porque cambió el DOM.
    if (status !== "connected" && status !== "loading") {
      emitStatus("loading");
    }

  } catch (e) {
    logger.warn(
      { err: e?.message || String(e) },
      "refreshState failed"
    );
  }
}
async function startWA(force=false){
 if(connecting&&!force)return;
 if(context&&!force){
  await refreshState();
  return;
 }
 connecting=true;latestQr=null;emitStatus("loading");
 try{
  await ensure();
  if(force||context)await closeBrowser("restart");

  lastBrowserInfo={
   engine:"playwright-chromium",
   headless:true,
   profileDir:PROFILE_DIR,
   startedAt:new Date().toISOString()
  };

context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: true,
  viewport: {
    width: 1365,
    height: 900
  },
  locale: "es-CO",
  timezoneId: "America/Bogota",

  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Safari/537.36",

  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check"
  ]
});
  page=context.pages()[0]||await context.newPage();
  page.on("close",()=>logger.warn("WhatsApp page closed"));
  context.on("close",()=>{
   if(status==="connected"||status==="qr_ready"||status==="loading"){
    lastDisconnectInfo={message:"Chromium context closed",at:new Date().toISOString()};
    emitStatus("disconnected");
   }
   context=null;page=null;connecting=false;latestQr=null;
  });

  await page.goto("https://web.whatsapp.com/",{waitUntil:"domcontentloaded",timeout:120000});
  await page.waitForTimeout(2500);
  connecting=false;
  await refreshState();

  clearInterval(monitorTimer);
  monitorTimer=setInterval(()=>refreshState().catch(()=>{}),2500);
 }catch(e){
  connecting=false;
  lastDisconnectInfo={message:e?.message||String(e),at:new Date().toISOString()};
  logger.error({err:e},"Failed to start Chromium WhatsApp Web");
  await closeBrowser("start-failed");
  emitStatus("disconnected");
 }
}

async function composerLocator(){
 const candidates=[
  '#main footer div[contenteditable="true"][role="textbox"]',
  '#main div[contenteditable="true"][role="textbox"]'
 ];
 for(const sel of candidates){
  const loc=page.locator(sel).last();
  if(await loc.count().catch(()=>0))return loc;
 }
 throw new Error("No se encontró el cuadro de mensaje de WhatsApp Web");
}

async function navigateToChat(to,text=""){
 if(status!=="connected"||!page||page.isClosed())throw new Error("WhatsApp no está conectado");
 const p=phone(to);if(!p)throw new Error("Número inválido");
 const url=`https://web.whatsapp.com/send?phone=${encodeURIComponent(p)}${text?`&text=${encodeURIComponent(text)}`:""}`;
 await page.goto(url,{waitUntil:"domcontentloaded",timeout:90000});
 await page.waitForSelector("#main",{timeout:45000});
 return p;
}

async function doSendText(to,text){
 const p=await navigateToChat(to,text);
 const composer=await composerLocator();
 await composer.waitFor({state:"visible",timeout:30000});
 await page.waitForTimeout(500);
 await composer.press("Enter");
 await page.waitForTimeout(1200);
 return p;
}

async function tempImageFrom(imageUrl){
 const ext=".jpg",file=path.join(os.tmpdir(),`wa-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
 if(imageUrl.startsWith("data:image/")){
  const m=imageUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if(!m)throw new Error("Imagen base64 inválida");
  await fs.writeFile(file,Buffer.from(m[2],"base64"));return file;
 }
 if(/^https?:\/\//i.test(imageUrl)){
  const r=await fetch(imageUrl);if(!r.ok)throw new Error(`No se pudo descargar imagen (${r.status})`);
  await fs.writeFile(file,Buffer.from(await r.arrayBuffer()));return file;
 }
 throw new Error("Formato de imagen no soportado");
}

async function doSendImage(to,message,imageUrl){
 const p=await navigateToChat(to,"");
 const file=await tempImageFrom(imageUrl);
 try{
  let input=page.locator('input[type="file"][accept*="image"]').first();
  if(!(await input.count().catch(()=>0))){
   const attach=page.locator('button[aria-label*="Attach"],button[aria-label*="Adjuntar"],button[title*="Attach"],button[title*="Adjuntar"]').first();
   if(await attach.count().catch(()=>0))await attach.click();
   await page.waitForTimeout(500);
   input=page.locator('input[type="file"]').first();
  }
  if(!(await input.count().catch(()=>0)))throw new Error("No se encontró selector de adjuntos");
  await input.setInputFiles(file);
  await page.waitForTimeout(1200);

  if(message){
   const caption=page.locator('div[contenteditable="true"][role="textbox"]').last();
   if(await caption.count().catch(()=>0))await caption.fill(message).catch(async()=>{await caption.click();await page.keyboard.type(message)});
  }

  const sendBtn=page.locator('button[aria-label="Send"],button[aria-label="Enviar"],[data-testid="compose-btn-send"]').last();
  if(await sendBtn.count().catch(()=>0))await sendBtn.click();
  else await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  return p;
 }finally{await fs.rm(file,{force:true}).catch(()=>{})}
}

async function sendText(to,text){
 const task=()=>doSendText(to,text);
 sendChain=sendChain.then(task,task);
 return sendChain;
}

async function sendImageOrText(to,message,imageUrl){
 if(!imageUrl)return sendText(to,message);
 const task=()=>doSendImage(to,message,imageUrl).catch(async e=>{
  logger.warn({err:e?.message||String(e)},"Image send failed; falling back to text");
  return doSendText(to,message);
 });
 sendChain=sendChain.then(task,task);
 return sendChain;
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


app.get("/health",(req,res)=>res.json({ok:true,service:"xiaomi-whatsapp-service",engine:"playwright-chromium",status}));
app.get("/api/whatsapp/status",(req,res)=>res.json({status,qr:latestQr}));
app.get("/api/whatsapp/diagnostics",(req,res)=>res.json({
 status,
 connecting,
 hasQr:Boolean(latestQr),
 lastPairingAt,
 lastBrowserInfo,
 lastDisconnect:lastDisconnectInfo,
 profileDir:PROFILE_DIR,
 dataDir:DATA_DIR
}));
app.post("/api/whatsapp/connect",(req,res)=>{
 startWA(Boolean(req.body?.force)).catch(e=>logger.error({err:e},"connect endpoint"));
 res.json({success:true,status,qr:latestQr});
});
app.post("/api/whatsapp/disconnect",async(req,res)=>{
 try{await clearProfile();emitStatus("disconnected");lastDisconnectInfo=null;lastPairingAt=null;res.json({success:true,status})}
 catch(e){res.status(500).json({success:false,error:e.message})}
});
app.post("/api/whatsapp/reset-session",async(req,res)=>{
 try{await clearProfile();emitStatus("disconnected");lastDisconnectInfo=null;lastPairingAt=null;logger.info({profileDir:PROFILE_DIR},"WhatsApp Chromium profile reset");res.json({success:true,message:"Sesión de WhatsApp eliminada. Ya puedes generar un QR nuevo.",status})}
 catch(error){logger.error({err:error},"reset-session failed");res.status(500).json({success:false,error:error.message})}
});
app.get("/api/whatsapp/debug-screenshot", async (req, res) => {
  try {
    if (!page || page.isClosed()) {
      return res.status(503).json({
        success: false,
        error: "Chromium no tiene una página activa"
      });
    }

    const screenshot = await page.screenshot({
      fullPage: true,
      type: "png"
    });

    res.setHeader("Content-Type", "image/png");
    res.send(screenshot);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/whatsapp/debug-page", async (req, res) => {
  try {
    if (!page || page.isClosed()) {
      return res.status(503).json({
        success: false,
        error: "Chromium no tiene una página activa"
      });
    }

    res.json({
      success: true,
      url: page.url(),
      title: await page.title(),
      text: (await page.locator("body").innerText()).slice(0, 5000)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
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


io.on("connection",socket=>{socket.emit("whatsapp-status",{status});if(latestQr)socket.emit("whatsapp-qr",{qr:latestQr})});
server.listen(PORT,"0.0.0.0",async()=>{
 await ensure();
 logger.info({PORT,ORIGINS,OLD_BACKEND_URL,PROFILE_DIR},"server started with Playwright Chromium");
 await resumeScheduledCampaigns();
 await resumePosJobs();
 const hasProfile=await profileHasData();
 if(hasProfile||process.env.AUTO_CONNECT==="true")startWA().catch(e=>logger.error({err:e},"startup WhatsApp"));
});
