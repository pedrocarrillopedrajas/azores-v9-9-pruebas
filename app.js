const SUPABASE_URL="https://lsuopaybsfdlofigxlac.supabase.co";
const SUPABASE_KEY="sb_publishable_MEXZiitQlDx4lrh_vV4dag_8sbBKe7O";
const SESSION_KEY="azores-cloud-session-v8";
let cloudSession=null, cloudReady=false, cloudSaving=false, cloudDirty=false, cloudTimer=null;
const cloudStatus=()=>document.getElementById("cloudStatus");
function setCloudStatus(message){const el=cloudStatus();if(el)el.textContent=message;}
function setCloudLock(locked){document.getElementById("appShell").hidden=locked;document.getElementById("loginPanel").hidden=!locked;}
function cloudHeaders(token){return {"apikey":SUPABASE_KEY,"Authorization":"Bearer "+token,"Content-Type":"application/json"};}
async function refreshCloudSession(){
 if(!cloudSession?.refresh_token)throw Error("Sesión caducada. Vuelve a entrar.");
 const r=await fetch(SUPABASE_URL+"/auth/v1/token?grant_type=refresh_token",{method:"POST",headers:{"apikey":SUPABASE_KEY,"Content-Type":"application/json"},body:JSON.stringify({refresh_token:cloudSession.refresh_token})});
 const j=await r.json();if(!r.ok)throw Error(j.msg||j.error_description||"No se pudo renovar la sesión");
 cloudSession=j;localStorage.setItem(SESSION_KEY,JSON.stringify(j));return j;
}
async function cloudFetch(path,options={}){
 let r=await fetch(SUPABASE_URL+path,{...options,headers:{...cloudHeaders(cloudSession.access_token),...(options.headers||{})}});
 if(r.status===401){await refreshCloudSession();r=await fetch(SUPABASE_URL+path,{...options,headers:{...cloudHeaders(cloudSession.access_token),...(options.headers||{})}});}
 if(!r.ok){let detail="";try{const j=await r.json();detail=j.message||j.msg||j.error_description||j.error||""}catch(_){}throw Error(detail||"Error de conexión ("+r.status+")");}
 return r;
}
// V9.27: fotos privadas en Supabase Storage. Las fotos antiguas Base64 se conservan.
const PHOTO_BUCKET="azores-fotos", PHOTO_PREFIX="storage:";
const photoUrlCache=new Map();
function photoIsStored(value){return typeof value==="string"&&value.startsWith(PHOTO_PREFIX);}
function photoPath(value){return value.slice(PHOTO_PREFIX.length);}
function photoDisplay(value){return photoIsStored(value)?(photoUrlCache.get(photoPath(value))||""):value||"";}
async function photoStorageFetch(path,options={}){
 const request=async()=>fetch(SUPABASE_URL+path,{...options,headers:{apikey:SUPABASE_KEY,Authorization:"Bearer "+cloudSession.access_token,...(options.headers||{})}});
 let response=await request();if(response.status===401){await refreshCloudSession();response=await request();}
 if(!response.ok){let message="Error de Storage ("+response.status+")";try{const d=await response.json();message=d.message||d.error||message;}catch{}throw Error(message);}
 return response;
}
async function uploadProductPhoto(dataUrl,productId){
 if(!cloudSession?.user?.id)throw Error("Inicia sesión para subir la foto");
 const raw=atob(dataUrl.split(",")[1]);const bytes=new Uint8Array(raw.length);
 for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
 const path=cloudSession.user.id+"/"+productId+"-"+crypto.randomUUID()+".jpg";
 await photoStorageFetch("/storage/v1/object/"+PHOTO_BUCKET+"/"+path,{method:"POST",headers:{"Content-Type":"image/jpeg","x-upsert":"false"},body:new Blob([bytes],{type:"image/jpeg"})});
 return PHOTO_PREFIX+path;
}
async function resolvePhoto(value){
 if(!photoIsStored(value))return value||"";
 const path=photoPath(value);if(photoUrlCache.has(path))return photoUrlCache.get(path);
 const r=await photoStorageFetch("/storage/v1/object/sign/"+PHOTO_BUCKET+"/"+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expiresIn:3600})});
 const data=await r.json();const url=SUPABASE_URL+data.signedURL;
 photoUrlCache.set(path,url);setTimeout(()=>photoUrlCache.delete(path),50*60*1000);
 return url;
}
function hydrateStoredPhotos(root=document){
 root.querySelectorAll("img[data-storage-photo]").forEach(async img=>{
  const value=img.getAttribute("data-storage-photo");
  if(!photoIsStored(value))return; // No tocar fotos antiguas Base64.
  try{const url=await resolvePhoto(value);if(img.isConnected&&img.getAttribute("data-storage-photo")===value)img.src=url;}
  catch(err){console.warn("AZORES: no se pudo cargar fotografía",err);}
 });
}
function queueCloudSave(){
 if(!cloudReady)return;
 cloudDirty=true;setCloudStatus("Cambios pendientes de sincronizar…");
 clearTimeout(cloudTimer);cloudTimer=setTimeout(flushCloudSave,350);
}
async function flushCloudSave(){
 if(!cloudReady||cloudSaving||!cloudDirty)return;
 cloudSaving=true;cloudDirty=false;
 const snapshot={products:JSON.parse(JSON.stringify(products)),finances:JSON.parse(JSON.stringify(finances))};
 setCloudStatus("Guardando en la nube…");
 try{
  await cloudFetch("/rest/v1/azores_state?on_conflict=user_id",{method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({user_id:cloudSession.user.id,data:snapshot,updated_at:new Date().toISOString()})});
  setCloudStatus(cloudDirty?"Cambios pendientes de sincronizar…":"✓ Sincronizado en Supabase");
 }catch(e){cloudDirty=true;setCloudStatus("⚠ Sin sincronizar: "+e.message+". Pulsa Reintentar.");}
 finally{cloudSaving=false;if(cloudDirty&&navigator.onLine&&cloudStatus()?.textContent?.startsWith("Cambios"))setTimeout(flushCloudSave,300);}
}
async function loadCloudState(){
 cloudReady=false;setCloudStatus("Cargando datos…");
 const r=await cloudFetch("/rest/v1/azores_state?select=data&user_id=eq."+encodeURIComponent(cloudSession.user.id));
 const rows=await r.json();
 if(rows.length){
  const d=rows[0].data;
  if(!d||!Array.isArray(d.products)||!d.finances||typeof d.finances!=="object")throw Error("Los datos de la nube no tienen el formato esperado");
  products=d.products;finances=d.finances;
 }else{
  // Primera conexión: la cuenta parte vacía. Nunca importar datos locales de otro dispositivo automáticamente.
  products=[];finances={opening:{Aurora:0,Pedro:0},contributions:[],withdrawals:[],capitalRepayments:[]};
 }
 finances.opening||={Aurora:0,Pedro:0};finances.contributions||=[];finances.withdrawals||=[];finances.capitalRepayments||=[];
 cacheLocalState();
 cloudReady=true;render();setCloudLock(false);setCloudStatus("✓ Conectado a Supabase");
}
async function startCloud(){
 try{
  const saved=localStorage.getItem(SESSION_KEY);if(!saved)return;
  cloudSession=JSON.parse(saved);if(!cloudSession?.user?.id)throw Error("Sesión inválida");
  await refreshCloudSession();await loadCloudState();
 }catch(e){cloudReady=false;setCloudLock(true);document.getElementById("loginError").textContent="Inicia sesión para acceder a AZORES. "+e.message;}
}
function signOutCloud(){
 if(cloudDirty||cloudSaving){alert("Hay cambios sin sincronizar. Reintenta la sincronización antes de salir.");return;}
 cloudReady=false;cloudSession=null;localStorage.removeItem(SESSION_KEY);
 products=[];finances={opening:{Aurora:0,Pedro:0},contributions:[],withdrawals:[],capitalRepayments:[]};
 localStorage.removeItem(KEY);localStorage.removeItem(FIN_KEY);setCloudLock(true);
 document.getElementById("loginForm").reset();document.getElementById("loginError").textContent="";
}
document.getElementById("loginForm").addEventListener("submit",async e=>{
 e.preventDefault();const button=document.getElementById("loginButton"),error=document.getElementById("loginError");
 button.disabled=true;error.textContent="Conectando…";
 try{
  const form=new FormData(e.currentTarget);
  const r=await fetch(SUPABASE_URL+"/auth/v1/token?grant_type=password",{method:"POST",headers:{"apikey":SUPABASE_KEY,"Content-Type":"application/json"},body:JSON.stringify({email:String(form.get("email")||"").trim(),password:String(form.get("password")||"")})});
  const j=await r.json();if(!r.ok)throw Error(j.error_description||j.msg||j.error||"Correo o contraseña incorrectos");
  cloudSession=j;localStorage.setItem(SESSION_KEY,JSON.stringify(j));await loadCloudState();error.textContent="";
 }catch(err){error.textContent=err.message;cloudReady=false;setCloudLock(true);}
 finally{button.disabled=false;}
});
document.getElementById("logoutButton").addEventListener("click",signOutCloud);
document.getElementById("retrySync").addEventListener("click",()=>{if(!cloudReady)return;cloudDirty=true;flushCloudSave()});
window.addEventListener("online",()=>{if(cloudDirty)flushCloudSave()});
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&cloudDirty)flushCloudSave()});
setCloudLock(true);startCloud();
const KEY="azores-prototype-products-v1";
let products=JSON.parse(localStorage.getItem(KEY)||"[]");
const FIN_KEY="azores-finances-v7";
let finances=JSON.parse(localStorage.getItem(FIN_KEY)||'{"opening":{"Aurora":0,"Pedro":0},"contributions":[],"withdrawals":[]}');
finances.opening ||= {Aurora:0,Pedro:0};finances.contributions ||= [];finances.withdrawals ||= [];finances.capitalRepayments ||= [];
function saveFin(){cacheLocalState();render();queueCloudSave()}
function normalizedAccount(v){return /aurora|auro/i.test(v||"")?"Aurora":/pedro/i.test(v||"")?"Pedro":null}
function purchaseMethod(p){return p.purchaseMethod||"Vinted"}
function receiver(p){return normalizedAccount(p.receivingAccount||p.account)}
function financesSummary(){
 const balances={Aurora:Number(finances.opening.Aurora)||0,Pedro:Number(finances.opening.Pedro)||0};
 const capital={Aurora:0,Pedro:0};
 for(const p of products){
   const payer=normalizedAccount(p.account),cost=Number(p.purchasePrice)||0;
   if(purchaseMethod(p)==="Personal"&&payer)capital[payer]+=cost;
   if(purchaseMethod(p)==="Vinted"&&payer)balances[payer]-=cost;
   if(isSold(p)&&p.paymentStatus==="Cobrado"){
     const r=receiver(p);if(r)balances[r]+=Number(p.salePrice)||0;
   }
 }
 for(const x of finances.contributions||[]){if(normalizedAccount(x.account))capital[normalizedAccount(x.account)]+=Number(x.amount)||0;if(x.toVinted&&normalizedAccount(x.account))balances[normalizedAccount(x.account)]+=Number(x.amount)||0}
 for(const x of finances.withdrawals||[]){const r=normalizedAccount(x.account);if(r)balances[r]-=Number(x.amount)||0}
 const repaid={Aurora:0,Pedro:0};
 for(const x of finances.capitalRepayments||[]){const who=normalizedAccount(x.account);if(who){repaid[who]+=Number(x.amount)||0;balances[who]-=Number(x.amount)||0}}
 const capitalPending={Aurora:Math.max(0,capital.Aurora-repaid.Aurora),Pedro:Math.max(0,capital.Pedro-repaid.Pedro)};
 const pending=products.reduce((t,p)=>t+(isSold(p)&&p.paymentStatus!=="Cobrado"?Number(p.salePrice)||0:0),0);
 const inventory=products.reduce((t,p)=>t+(!isSold(p)?Number(p.purchasePrice)||0:0),0);
 const profit=products.reduce((t,p)=>t+(isSold(p)?Number(p.salePrice)-Number(p.purchasePrice||0):0),0);
 return {balances,capital,repaid,capitalPending,pending,inventory,profit,total:balances.Aurora+balances.Pedro};
}
let activeTab="Inicio", photoData="", editingId=null, editingSaleId=null, editingShipmentId=null;
let cataTimer=null, cataLastTab=null;
let salesGroupOpen=null; // null: ambas ramas cerradas
const trackingPreview=new Map();
let trackingRun=0;
const $=s=>document.querySelector(s);
const money=n=>(Number(n)||0).toLocaleString("es-ES",{style:"currency",currency:"EUR"});
// La nube es el origen de verdad. Una caché local llena no debe impedir guardar.
function cacheLocalState(){
 try{localStorage.setItem(KEY,JSON.stringify(products));localStorage.setItem(FIN_KEY,JSON.stringify(finances));}
 catch(err){console.warn("AZORES: caché local llena; se conservará la sincronización en la nube",err);}
}
function save(){cacheLocalState();render();queueCloudSave()}
function stats(){
 const f=financesSummary();
 document.getElementById("homeCash").textContent=money(f.total);
 if(f.total<=0){const cata=document.getElementById("cataCelebration");if(cata)cata.hidden=true;}
 document.getElementById("homePending").textContent=money(f.pending);
 document.getElementById("homeStock").textContent=products.filter(p=>!isSold(p)).length;
}
function isSold(p){return p.salePrice!==""&&p.salePrice!=null}
function productStatus(p){return isSold(p)?"Vendido":(p.status||"Sin vender")}
function render(){
 queueMicrotask(()=>hydrateStoredPhotos(document));
 stats();$("#sectionTitle").textContent=activeTab;
 const home=activeTab==="Inicio";
 if(home && cataLastTab!=="Inicio") {
   const cata=document.getElementById("cataCelebration");
   if(cata){
     clearTimeout(cataTimer);
     cata.hidden=financesSummary().total<=0;
     if(!cata.hidden){
       const picture=cata.querySelector("img");
       picture.src="cata-celebracion.gif?play="+Date.now();
       cataTimer=setTimeout(()=>{cata.hidden=true},3000);
     }
   }
 } else if(!home){
   clearTimeout(cataTimer);
   const cata=document.getElementById("cataCelebration");if(cata)cata.hidden=true;
 }
 cataLastTab=activeTab;
 $("#homeSummary").hidden=!home;
 document.querySelector(".content-card").classList.toggle("home-navigation",home);
 document.querySelector(".section-heading").hidden=home;
 document.querySelector(".welcome").hidden=home;
 document.querySelectorAll("[data-tab]").forEach(b=>b.classList.toggle("active",b.dataset.tab===activeTab));
 const view=$("#view");
 if(home){view.innerHTML="";return;}
 if(activeTab==="Compras"||activeTab==="Inventario"){
   const rows=products.filter(p=>activeTab==="Compras"||!isSold(p));
   rows.sort((a,b)=>String(b.purchaseDate||"").localeCompare(String(a.purchaseDate||"")) || products.indexOf(b)-products.indexOf(a));
   if(!rows.length){view.innerHTML=`<div class="empty"><div class="symbol">▧</div><h3>${activeTab==="Compras"?"Todavía no hay compras":"Tu inventario está vacío"}</h3><p>Añade el primer producto para empezar a organizar AZORES.</p><button class="primary" id="emptyAdd">＋ Añadir producto</button></div>`;$("#emptyAdd").onclick=()=>openDialog();return}
   view.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Producto</th><th>Compra</th><th>Coste</th><th>Cuenta</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${rows.map(p=>`<tr><td><div class="product-cell">${p.photo?`<img class="thumb zoomable-photo" src="${esc(photoDisplay(p.photo))}" data-storage-photo="${photoIsStored(p.photo)?esc(p.photo):""}" alt="Ampliar foto de ${esc(p.name)}" tabindex="0" role="button" loading="lazy">`:`<span class="thumb">▧</span>`}<strong>${esc(p.name)}</strong></div></td><td>${p.purchaseDate||"—"}</td><td>${money(p.purchasePrice)}</td><td>${esc(p.account||"—")}</td><td><span class="pill">${esc(productStatus(p))}</span></td><td><div class="action-group"><button type="button" class="edit-product" data-edit="${esc(p.id)}">Editar</button>${!isSold(p)?`<button type="button" class="edit-product" data-sell="${esc(p.id)}">Vender</button><button type="button" class="edit-product delete-product" data-delete="${esc(p.id)}" aria-label="Eliminar compra de ${esc(p.name)}">Eliminar</button>`:""}</div></td></tr>`).join("")}</tbody></table></div>`;
 }else if(activeTab==="Ventas"){
   const sold=products.filter(isSold);
   const byDate=(a,b)=>String(b.saleDate||"").localeCompare(String(a.saleDate||""));
   const pending=sold.filter(p=>p.paymentStatus!=="Cobrado").sort(byDate);
   const paid=sold.filter(p=>p.paymentStatus==="Cobrado").sort(byDate);
   const saleRow=p=>`<tr><td class="sale-product"><div class="product-cell">${p.photo?`<img class="thumb zoomable-photo" src="${esc(photoDisplay(p.photo))}" data-storage-photo="${photoIsStored(p.photo)?esc(p.photo):""}" alt="Ampliar foto de ${esc(p.name)}" tabindex="0" role="button" loading="lazy">`:`<span class="thumb" aria-hidden="true">▧</span>`}<strong>${esc(p.name)}</strong></div></td><td>${esc(p.saleDate||"—")}</td><td>${money(p.salePrice)}</td><td>${esc(p.buyer||"—")}</td><td><span class="pill">${esc(p.paymentStatus||"—")}</span></td><td>${money(Number(p.salePrice)-Number(p.purchasePrice||0))}</td><td><div class="action-group"><button class="edit-product" data-sale-edit="${esc(p.id)}">Editar venta</button><button class="edit-product" data-sale-cancel="${esc(p.id)}">Anular venta</button></div></td></tr>`;
   const current=salesGroupOpen==="pending"?pending:salesGroupOpen==="paid"?paid:null;
   view.innerHTML=`<div class="action-group sales-toolbar"><button class="primary" id="addSale" ${products.some(p=>!isSold(p))?"":"disabled"}>＋ Registrar venta</button><button type="button" class="sales-group-toggle ${salesGroupOpen==="pending"?"selected":""}" data-sales-group="pending" aria-expanded="${salesGroupOpen==="pending"}">Pendientes (${pending.length}) <span aria-hidden="true">${salesGroupOpen==="pending"?"⌃":"⌄"}</span></button><button type="button" class="sales-group-toggle ${salesGroupOpen==="paid"?"selected":""}" data-sales-group="paid" aria-expanded="${salesGroupOpen==="paid"}">Cobradas (${paid.length}) <span aria-hidden="true">${salesGroupOpen==="paid"?"⌃":"⌄"}</span></button></div>${current?(current.length?`<div class="table-wrap"><table><thead><tr><th>Producto</th><th>Fecha</th><th>Precio venta</th><th>Comprador</th><th>Cobro</th><th>Beneficio</th><th>Acciones</th></tr></thead><tbody>${current.map(saleRow).join("")}</tbody></table></div>`:`<div class="simple-panel"><strong>No hay ventas ${salesGroupOpen==="paid"?"cobradas":"pendientes de cobro"}</strong></div>`):`<div class="simple-panel sales-empty-hint">${sold.length?"Selecciona Pendientes o Cobradas para ver las ventas.":"Aún no hay ventas. Pulsa Registrar venta para empezar."}</div>`}`;
   const add=$("#addSale");if(add)add.onclick=()=>openSaleDialog();
   view.querySelectorAll("[data-sales-group]").forEach(btn=>btn.onclick=()=>{salesGroupOpen=salesGroupOpen===btn.dataset.salesGroup?null:btn.dataset.salesGroup;render()});
 }else if(activeTab==="Envíos"){
   const sold=products.filter(p=>isSold(p)&&p.paymentStatus!=="Cobrado");
   view.innerHTML=`<span id="testVintedGoResult" role="status" hidden></span>`+(sold.length?`<div class="table-wrap"><table><thead><tr><th>Producto</th><th>Comprador</th><th>Transportista</th><th>Seguimiento</th><th>Estado del paquete</th><th>Última actualización</th><th>Acciones</th></tr></thead><tbody>${sold.map(p=>{const sh=p.shipping||{};const preview=trackingPreview.get(p.id);const effective=preview||sh;const updated=effective.lastUpdated?new Date(effective.lastUpdated).toLocaleString("es-ES",{dateStyle:"short",timeStyle:"short"}):"Pendiente de consulta automática";return `<tr><td><strong>${esc(p.name)}</strong></td><td>${esc(p.buyer||"—")}</td><td>${esc(sh.carrier||"—")}</td><td>${safeTrackingLink(sh.trackingUrl)}</td><td><span class="pill">${esc(effective.status||"Pendiente de seguimiento")}</span></td><td>${esc(updated)}</td><td><button type="button" class="edit-product" data-ship-edit="${esc(p.id)}">Editar envío</button></td></tr>`}).join("")}</tbody></table></div><p class="muted">El estado del paquete es independiente del cobro. Los envíos permanecen aquí hasta que marques la venta como «Cobrado».</p>`:`<div class="simple-panel"><strong>No hay envíos pendientes de cobro</strong><p>Los pedidos pendientes de cobro aparecerán aquí automáticamente.</p></div>`);
   const testButton=document.getElementById("testVintedGo");if(testButton)testButton.onclick=refreshVintedGoPreviews;
 }else if(activeTab==="Cuentas"){
   const f=financesSummary();
   view.innerHTML=`<div class="finance-grid">
   <article class="finance-box"><small>Saldo Vinted Aurora</small><strong>${money(f.balances.Aurora)}</strong></article>
   <article class="finance-box"><small>Saldo Vinted Pedro</small><strong>${money(f.balances.Pedro)}</strong></article>
   <article class="finance-box"><small>Dinero disponible AZORES</small><strong>${money(f.total)}</strong></article>
   <article class="finance-box"><small>Ventas pendientes de cobro</small><strong>${money(f.pending)}</strong></article>
   <article class="finance-box"><small>Inventario a coste</small><strong>${money(f.inventory)}</strong></article>
   <article class="finance-box"><small>Beneficio de ventas</small><strong>${money(f.profit)}</strong></article></div>
   <div class="simple-panel"><h3>Aportaciones personales registradas</h3><p>Aurora: <b>${money(f.capital.Aurora)}</b> · Pedro: <b>${money(f.capital.Pedro)}</b></p><p>Las aportaciones no son beneficios. Una compra pagada con dinero personal cuenta como aportación y no reduce el saldo de Vinted.</p></div>
   <div class="simple-panel"><h3>Devolución de aportaciones</h3><p>Solo registra aquí una devolución real del capital a un socio. Se descuenta del saldo Vinted correspondiente y reduce el capital pendiente de liquidar; no es un gasto ni reduce el beneficio.</p><div class="form-grid"><label>Socio<select id="repayOwner"><option>Aurora</option><option>Pedro</option></select></label><label>Importe (€)<input id="repayAmount" type="number" min="0.01" step="0.01"></label></div><button class="primary" id="addRepayment">Registrar devolución de capital</button></div>
   <div class="simple-panel"><h3>Saldos de partida (datos de prueba)</h3><p>Configura aquí el saldo inicial de cada cuenta antes de las operaciones registradas en esta versión. No incluyas aquí ingresos que ya figuren como ventas cobradas.</p><div class="form-grid"><label>Aurora (€)<input id="openingAurora" type="number" step="0.01" value="${finances.opening.Aurora||0}"></label><label>Pedro (€)<input id="openingPedro" type="number" step="0.01" value="${finances.opening.Pedro||0}"></label></div><button class="primary" id="saveOpening">Guardar saldos iniciales</button></div>
   <div class="simple-panel"><h3>Registrar aportación adicional</h3><p>Para dinero personal aportado al negocio que no esté ya reflejado en una compra personal.</p><div class="form-grid"><label>Socio<select id="capitalOwner"><option>Aurora</option><option>Pedro</option></select></label><label>Importe (€)<input id="capitalAmount" type="number" min="0.01" step="0.01"></label></div><label><input id="capitalToVinted" type="checkbox"> El dinero se ingresó en el saldo Vinted de ese socio</label><p><button class="primary" id="addCapital">Añadir aportación</button></p></div>
   <div class="simple-panel"><h3>Registrar retirada de saldo</h3><p>Dinero retirado de Vinted; se descuenta de la caja de AZORES. No modifica automáticamente las aportaciones ni el reparto de beneficios.</p><div class="form-grid"><label>Cuenta<select id="withdrawOwner"><option>Aurora</option><option>Pedro</option></select></label><label>Importe (€)<input id="withdrawAmount" type="number" min="0.01" step="0.01"></label></div><button class="primary" id="addWithdrawal">Registrar retirada</button></div>`;
   $("#saveOpening").onclick=()=>{const x=Number($("#openingAurora").value),y=Number($("#openingPedro").value);if(!Number.isFinite(x)||!Number.isFinite(y))return alert("Introduce saldos válidos");finances.opening={Aurora:x,Pedro:y};saveFin()};
   $("#addCapital").onclick=()=>{const n=Number($("#capitalAmount").value);if(!(n>0))return alert("Introduce un importe positivo");finances.contributions.push({id:crypto.randomUUID(),account:$("#capitalOwner").value,amount:n,toVinted:$("#capitalToVinted").checked});saveFin()};
   $("#addRepayment").onclick=()=>{const n=Number($("#repayAmount").value),who=$("#repayOwner").value,f=financesSummary();if(!Number.isFinite(n)||n<=0)return alert("Introduce un importe positivo");if(n>f.capitalPending[who]+0.001)return alert("No puedes devolver más capital del pendiente de ese socio");if(n>f.balances[who]+0.001)return alert("No hay saldo Vinted suficiente en esa cuenta");if(!confirm("¿Confirmas que has devuelto realmente "+money(n)+" a "+who+" desde su saldo Vinted?"))return;finances.capitalRepayments.push({id:crypto.randomUUID(),account:who,amount:n});saveFin()};
   $("#addWithdrawal").onclick=()=>{const n=Number($("#withdrawAmount").value);if(!(n>0))return alert("Introduce un importe positivo");finances.withdrawals.push({id:crypto.randomUUID(),account:$("#withdrawOwner").value,amount:n});saveFin()};
 }else if(activeTab==="Beneficios"){
   const f=financesSummary();const currentProfit=Math.max(0,Math.min(f.profit,f.total));const capitalOutstanding=f.capitalPending.Aurora+f.capitalPending.Pedro;const excessCash=Math.max(0,f.total-400);const withdrawalAvailable=capitalOutstanding>0?0:Math.min(currentProfit,excessCash);const withdrawalNote=f.total<=400?"La caja aún no supera los 400 €. No corresponde retirar dinero.":capitalOutstanding>0?"Primero hay que devolver las aportaciones pendientes, usando solo el dinero que supere los 400 € de caja. No corresponde repartir beneficios todavía.":"Las aportaciones están recuperadas. El beneficio que podría retirarse está limitado al excedente sobre 400 € y al beneficio actual.";view.innerHTML=`<div class="finance-grid"><article class="finance-box"><small>Beneficio total generado por ventas</small><strong>${money(f.profit)}</strong></article><article class="finance-box"><small>Beneficio actual</small><strong>${money(currentProfit)}</strong></article><article class="finance-box"><small>Beneficio Auro · 60 %</small><strong>${money(currentProfit*.6)}</strong></article><article class="finance-box"><small>Beneficio Pedro · 40 %</small><strong>${money(currentProfit*.4)}</strong></article><article class="finance-box"><small>Importe pendiente de cobro</small><strong>${money(f.pending)}</strong></article><article class="finance-box"><small>Capital pendiente · Aurora</small><strong>${money(f.capitalPending.Aurora)}</strong></article><article class="finance-box"><small>Capital pendiente · Pedro</small><strong>${money(f.capitalPending.Pedro)}</strong></article><article class="finance-box"><small>Capital total por devolver</small><strong>${money(f.capitalPending.Aurora+f.capitalPending.Pedro)}</strong></article></div><div class="simple-panel"><h3>Detalle de aportaciones</h3><p>Aurora: aportado <b>${money(f.capital.Aurora)}</b> · devuelto <b>${money(f.repaid.Aurora)}</b> · pendiente <b>${money(f.capitalPending.Aurora)}</b></p><p>Pedro: aportado <b>${money(f.capital.Pedro)}</b> · devuelto <b>${money(f.repaid.Pedro)}</b> · pendiente <b>${money(f.capitalPending.Pedro)}</b></p><p>Las compras pagadas con dinero personal se suman automáticamente al capital de quien las pagó. Las compras pagadas con saldo Vinted no generan aportaciones. Para registrar una devolución real, utiliza Cuentas → Devolución de aportaciones.</p><p>El beneficio total generado suma los márgenes de las ventas, aunque el cobro esté pendiente. El beneficio actual es el menor entre el beneficio acumulado por ventas y el saldo disponible en caja (sin mostrar valores negativos). Auro tiene asignado el 60 % y Pedro el 40 %. Estas cifras son informativas y no significan que el dinero pueda retirarse.</p><p><b>Regla de retirada (reserva de 400 €):</b> ${withdrawalNote}</p><p><b>Beneficio orientativo disponible para retirar ahora:</b> ${money(withdrawalAvailable)}. Las retiradas y devoluciones deben registrarse manualmente en Cuentas; AZORES no mueve dinero automáticamente.</p></div>`;
 }else{
   const descriptions={Ventas:"Cuando registremos ventas, aquí aparecerán el precio, comprador, cobro y beneficio de cada operación.",Envíos:"Aquí conectaremos los envíos de los productos vendidos: transportista y enlace directo al seguimiento del paquete.",Cuentas:"Aquí calcularemos los movimientos, aportaciones y dinero disponible, respetando las cuentas de Aurora y Pedro.",Beneficios:"Aquí aparecerán los beneficios y el reparto acordado: 60 % Aurora y 40 % Pedro."};
   view.innerHTML=`<div class="simple-panel"><strong>${activeTab}</strong><p>${descriptions[activeTab]}</p><small>Esta sección se activará al conectar los datos con Compras e Inventario.</small></div>`;
 }
}

function vintedGoNumber(p){
 if(!isSold(p)||p.paymentStatus==="Cobrado"||!/vinted\s*go/i.test(p.shipping?.carrier||""))return null;
 try{
  const u=new URL(p.shipping?.trackingUrl||"");
  if(u.protocol!=="https:"||u.hostname!=="vintedgo.com")return null;
  return u.pathname.match(/^\/es\/tracking\/(\d{16})\/?$/)?.[1]||null;
 }catch{return null;}
}
// Caché temporal por pestaña: evita consultas repetidas al volver a Envíos.
// No modifica productos, cobros, almacenamiento permanente ni Supabase.
const TRACKING_INTERVAL_MS=15*60*1000;
const TRACKING_CACHE_KEY="azores-v9-11-tracking-cache";
function readTrackingCache(){
 try{
  const parsed=JSON.parse(sessionStorage.getItem(TRACKING_CACHE_KEY)||"{}");
  return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:{};
 }catch{return {};}
}
function writeTrackingCache(cache){
 try{sessionStorage.setItem(TRACKING_CACHE_KEY,JSON.stringify(cache));}catch{}
}
async function refreshVintedGoPreviews(){
 if(!cloudReady||!cloudSession?.access_token||activeTab!=="Envíos")return;
 const run=++trackingRun;
 const button=document.getElementById("testVintedGo");
 const output=document.getElementById("testVintedGoResult");
 const candidates=products.map(p=>({p,number:vintedGoNumber(p)})).filter(x=>x.number);
 if(!output)return;
 if(!candidates.length){output.textContent="No hay envíos Vinted Go pendientes con enlace válido.";return;}
 const cache=readTrackingCache();
 const now=Date.now();
 let cached=0,changed=0,unchanged=0,failed=0;
 const pending=[];
 for(const {p,number} of candidates){
  const key=String(p.id)+":"+number;
  const entry=cache[key];
  if(entry&&Number.isFinite(entry.checkedAt)&&now-entry.checkedAt>=0&&now-entry.checkedAt<TRACKING_INTERVAL_MS&&typeof entry.status==="string"&&Number.isFinite(Date.parse(entry.lastUpdated))){
   const previous=trackingPreview.get(p.id);
   if(!previous||previous.status!==entry.status||previous.lastUpdated!==entry.lastUpdated){
    trackingPreview.set(p.id,{status:entry.status,lastUpdated:entry.lastUpdated});changed++;
   }
   cached++;
  }else pending.push({p,number,key});
 }
 if(button)button.disabled=true;
 output.textContent=pending.length?"Consultando "+pending.length+" envío(s); "+cached+" en caché…":"Sin consultas nuevas: "+cached+" envío(s) revisados hace menos de 15 minutos.";
 for(const {p,number,key} of pending){
  if(run!==trackingRun)break;
  try{
   const response=await cloudFetch("/functions/v1/azores-prueba-vintedgo?seguimiento="+encodeURIComponent(number),{method:"POST",body:"{}"});
   const result=await response.json();
   if(result.resultado!=="Seguimiento leído"||typeof result.estadoPaquete!=="string"||!Number.isFinite(Date.parse(result.ultimaActualizacion)))throw Error("Respuesta de seguimiento no válida");
   const next={status:result.estadoPaquete,lastUpdated:result.ultimaActualizacion};
   const previous=trackingPreview.get(p.id);
   if(!previous||previous.status!==next.status||previous.lastUpdated!==next.lastUpdated){trackingPreview.set(p.id,next);changed++;}
   else unchanged++;
   cache[key]={...next,checkedAt:Date.now()};
   writeTrackingCache(cache);
  }catch(error){failed++;}
 }
 if(run!==trackingRun)return;
 if(activeTab==="Envíos"){
  // Redibujar únicamente si cambió el estado o la fecha visibles.
  if(changed)render();
  const currentButton=document.getElementById("testVintedGo");
  if(currentButton)currentButton.disabled=false;
  const currentOutput=document.getElementById("testVintedGoResult");
  if(currentOutput)currentOutput.textContent="Seguimiento: "+changed+" novedad(es), "+unchanged+" sin cambios, "+cached+" en caché (<15 min), "+failed+" error(es). Solo lectura.";
 }
}

function safeTrackingLink(url){
 if(!url)return "—";
 try{const u=new URL(url);if(!["https:","http:"].includes(u.protocol))return "Enlace no válido";return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">Abrir seguimiento</a>`}catch{return "Enlace no válido"}
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
const dialog=$("#productDialog");
function openDialog(id=null){
 editingId=typeof id==="string"?id:null;
 const p=products.find(item=>item.id===editingId);
 const form=$("#productForm");form.reset();$("#saveProductButton").disabled=false;
 $("#productFormMessage").textContent="";
 photoData=p?.photo||"";
 form.elements.name.value=p?.name||"";
 form.elements.purchaseDate.value=p?.purchaseDate||"";
 form.elements.purchasePrice.value=p?.purchasePrice||"";
 form.elements.origin.value=p?.origin||"";
 form.elements.account.value=p?.account||"";
 form.elements.purchaseMethod.value=p?.purchaseMethod||"Vinted";
 form.elements.status.value=p?productStatus(p):"Sin vender";
 form.elements.status.disabled=!!p&&isSold(p);
 updateProductPhotoPreview();
 $("#dialogTitle").textContent=p?"Editar producto":"Nuevo producto";
 $("#saveProductButton").textContent=p?"Guardar cambios":"Guardar producto";
 dialog.showModal();
}
$("#newProduct").onclick=()=>openDialog();$("#newProductTop").onclick=()=>openDialog();$("#closeDialog").onclick=()=>dialog.close();$("#cancelDialog").onclick=()=>dialog.close();
document.querySelectorAll("[data-tab]").forEach(b=>b.addEventListener("click",()=>{activeTab=b.dataset.tab;if(activeTab==="Ventas")salesGroupOpen=null;render();if(activeTab==="Envíos")refreshVintedGoPreviews()}));
function updateProductPhotoPreview(){
 $("#photoPreview").innerHTML=photoData?`<img src="${esc(photoDisplay(photoData))}" data-storage-photo="${photoIsStored(photoData)?esc(photoData):""}" alt="Vista previa">`:"";
 hydrateStoredPhotos($("#photoPreview"));
 $("#removeProductPhoto").hidden=!photoData;
}
$("#removeProductPhoto").addEventListener("click",()=>{
 photoData="";
 $("#productForm [name=photo]").value="";
 updateProductPhotoPreview();
 $("#productFormMessage").textContent="Fotografía eliminada. Pulsa Guardar cambios para confirmar.";
});
async function compressProductPhoto(file){
 const url=URL.createObjectURL(file);
 try{
  const img=new Image();img.src=url;
  await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error("Imagen no compatible"));});
  const max=900,scale=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));
  canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
  const ctx=canvas.getContext("2d");if(!ctx)throw Error("No se pudo procesar la imagen");
  ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(img,0,0,canvas.width,canvas.height);
  return canvas.toDataURL("image/jpeg",0.68);
 }finally{URL.revokeObjectURL(url);}
}
$("#productForm [name=photo]").addEventListener("change",e=>{
 const f=e.target.files[0];if(!f)return;
 if(!f.type.startsWith("image/")){$("#productFormMessage").textContent="Selecciona una imagen válida.";return;}
 // Reducir fotos de cámara antes de almacenarlas o enviarlas a Supabase.
 $("#saveProductButton").disabled=true;
 $("#productFormMessage").textContent="Optimizando fotografía…";
 compressProductPhoto(f).then(data=>{
  photoData=data;updateProductPhotoPreview();
  $("#saveProductButton").disabled=false;
  $("#productFormMessage").textContent="Fotografía optimizada. Pulsa Guardar cambios.";
 }).catch(err=>{$("#saveProductButton").disabled=false;$("#productFormMessage").textContent="No se pudo preparar la fotografía: "+err.message;});
});
$("#view").addEventListener("click",e=>{const b=e.target.closest("[data-edit]");if(b)openDialog(b.dataset.edit);const sell=e.target.closest("[data-sell]");if(sell)openSaleDialog(sell.dataset.sell);const editSale=e.target.closest("[data-sale-edit]");if(editSale)openSaleDialog(editSale.dataset.saleEdit,true);const cancel=e.target.closest("[data-sale-cancel]");if(cancel)cancelSale(cancel.dataset.saleCancel);const ship=e.target.closest("[data-ship-edit]");if(ship)openShippingDialog(ship.dataset.shipEdit);const del=e.target.closest("[data-delete]");if(del)deletePurchase(del.dataset.delete)});
function deletePurchase(id){
 if(!cloudReady){alert("Espera a que se conecte Supabase antes de eliminar una compra.");return;}
 if(cloudDirty||cloudSaving){alert("Hay cambios pendientes de sincronizar. Espera a que aparezca 'Sincronizado en Supabase' antes de eliminar.");return;}
 const p=products.find(x=>x.id===id);
 if(!p)return;
 if(isSold(p)){alert("Esta compra tiene una venta registrada. Primero anula la venta si realmente quieres eliminar la compra.");return;}
 if(!confirm(`¿Eliminar definitivamente la compra de "${p.name}"?\n\nSe quitará también del inventario y se recalcularán las cuentas. Esta acción no se puede deshacer desde la aplicación.\n\n¿Quieres continuar?`))return;
 products=products.filter(x=>x.id!==id);
 save();
}
$("#productForm").addEventListener("submit",async e=>{
 e.preventDefault();
 const form=e.currentTarget;
 if(!form.checkValidity()){
  const invalid=form.querySelector(":invalid");
  $("#productFormMessage").textContent="Revisa este campo antes de guardar: "+(invalid?.closest("label")?.textContent?.trim()||"campo obligatorio");
  invalid?.focus();form.reportValidity();return;
 }
 if(!cloudReady){$("#productFormMessage").textContent="Espera a que AZORES conecte con la nube.";return;}
 const button=$("#saveProductButton");button.disabled=true;
 const productId=editingId||crypto.randomUUID();
 let finalPhoto=photoData;
 try{
  if(typeof photoData==="string"&&photoData.startsWith("data:image/")){
   $("#productFormMessage").textContent="Subiendo fotografía a Supabase…";
   finalPhoto=await uploadProductPhoto(photoData,productId);
  }
 }catch(error){$("#productFormMessage").textContent="No se ha guardado: "+error.message;button.disabled=false;return;}
 const f=new FormData(form);
 const fields={name:f.get("name"),purchaseDate:f.get("purchaseDate"),purchasePrice:f.get("purchasePrice"),origin:f.get("origin"),account:f.get("account"),purchaseMethod:f.get("purchaseMethod"),status:editingId&&products.find(x=>x.id===editingId)&&isSold(products.find(x=>x.id===editingId))?"Vendido":f.get("status"),photo:finalPhoto};
 if(editingId){const p=products.find(item=>item.id===editingId);if(!p)return;Object.assign(p,fields)}
 else products.push({id:productId,...fields,salePrice:""});
 try{save();dialog.close();activeTab="Inventario";render();}
 catch(error){$("#productFormMessage").textContent="No se pudieron guardar los cambios: "+error.message;}
 finally{button.disabled=false;}
});
const saleDialog=$("#saleDialog"),saleForm=$("#saleForm");
function openSaleDialog(id=null,edit=false){
 editingSaleId=edit?id:null;
 const p=products.find(x=>x.id===id);
 const choices=products.filter(x=>!isSold(x)||x.id===editingSaleId);
 if(!choices.length)return;
 saleForm.reset();
 $("#saleProduct").innerHTML=choices.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
 $("#saleProduct").value=p?.id||choices[0].id;
 $("#saleProduct").disabled=!!edit;
 saleForm.elements.saleDate.value=p?.saleDate||new Date().toLocaleDateString("en-CA");
 saleForm.elements.salePrice.value=edit?p.salePrice:"";
 saleForm.elements.buyer.value=edit?p.buyer||"":"";
 saleForm.elements.paymentStatus.value=edit?p.paymentStatus||"Pendiente de cobro":"Pendiente de cobro";
 saleForm.elements.receivingAccount.value=edit?receiver(p)||"":normalizedAccount(p?.account)||"";
 $("#saleDialogTitle").textContent=edit?"Editar venta":"Registrar venta";
 updateSaleSummary();saleDialog.showModal();
}
function updateSaleSummary(){
 const p=products.find(x=>x.id===$("#saleProduct").value);
 const value=saleForm.elements.salePrice.value;
 $("#saleSummary").innerHTML=p&&value!==""?`Coste: ${money(p.purchasePrice)} · Venta: ${money(value)}<strong>Beneficio: ${money(Number(value)-Number(p.purchasePrice||0))}</strong><small>Reparto orientativo: Aurora ${money((Number(value)-Number(p.purchasePrice||0))*.6)} · Pedro ${money((Number(value)-Number(p.purchasePrice||0))*.4)}</small>`:"Selecciona un producto e indica el precio de venta.";
}
$("#saleProduct").addEventListener("change",updateSaleSummary);
saleForm.elements.salePrice.addEventListener("input",updateSaleSummary);
$("#closeSaleDialog").onclick=()=>saleDialog.close();
$("#cancelSaleDialog").onclick=()=>saleDialog.close();
saleForm.addEventListener("submit",e=>{
 e.preventDefault();
 const p=products.find(x=>x.id===(editingSaleId||$("#saleProduct").value));if(!p)return;
 if(!editingSaleId&&isSold(p))return alert("Este producto ya figura como vendido.");
 if(!editingSaleId){p.shipping={carrier:"",trackingNumber:"",trackingUrl:"",status:"Pendiente de envío"}}
 if(!editingSaleId)p.statusBeforeSale=p.status&&p.status!=="Vendido"?p.status:"Sin vender";
 p.saleDate=saleForm.elements.saleDate.value;
 p.salePrice=saleForm.elements.salePrice.value;
 p.buyer=saleForm.elements.buyer.value.trim();
 p.paymentStatus=saleForm.elements.paymentStatus.value;
 p.receivingAccount=saleForm.elements.receivingAccount.value;
 p.status="Vendido";
 save();saleDialog.close();activeTab="Ventas";render();
});
function cancelSale(id){
 const p=products.find(x=>x.id===id);
 if(!p||!isSold(p))return;
 if(!confirm(`¿Anular la venta de "${p.name}"? El producto volverá al inventario y el beneficio dejará de contabilizarse.`))return;
 p.status=p.statusBeforeSale&&p.statusBeforeSale!=="Vendido"?p.statusBeforeSale:"Sin vender";
 delete p.statusBeforeSale;
 p.salePrice="";
 delete p.saleDate;
 delete p.buyer;
 delete p.paymentStatus;
 delete p.receivingAccount;
 delete p.shipping;
 activeTab="Inventario";
 save();
}
const shippingDialog=$("#shippingDialog"),shippingForm=$("#shippingForm");
function openShippingDialog(id){
 const p=products.find(x=>x.id===id);if(!p||!isSold(p))return;
 editingShipmentId=id;shippingForm.reset();
 $("#shippingProductName").textContent=p.name;
 shippingForm.elements.carrier.value=p.shipping?.carrier||"";
 shippingForm.elements.trackingUrl.value=p.shipping?.trackingUrl||"";
 shippingDialog.showModal();
}
$("#closeShippingDialog").onclick=()=>shippingDialog.close();
$("#cancelShippingDialog").onclick=()=>shippingDialog.close();
shippingForm.addEventListener("submit",e=>{
 e.preventDefault();const p=products.find(x=>x.id===editingShipmentId);if(!p||!isSold(p))return;
 const f=new FormData(shippingForm);
 p.shipping={...(p.shipping||{}),carrier:String(f.get("carrier")||"").trim(),trackingNumber:p.shipping?.trackingNumber||"",trackingUrl:String(f.get("trackingUrl")||"").trim(),status:p.shipping?.status||"Pendiente de seguimiento",lastUpdated:p.shipping?.lastUpdated||null,events:Array.isArray(p.shipping?.events)?p.shipping.events:[]};
 save();shippingDialog.close();
});
render();
// Comprobar nuevas versiones al iniciar y al volver a la aplicación.
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  let updateNoticeShown = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (updateNoticeShown) return;
    updateNoticeShown = true;
    // No recargar silenciosamente: el usuario puede estar editando un formulario.
    if (window.confirm("Hay una nueva versión de AZORES disponible. ¿Actualizar ahora? Guarda antes cualquier cambio que estés editando.")) {
      location.reload();
    }
  });
  navigator.serviceWorker.register("./sw.js", {updateViaCache: "none"}).then(registration => {
    const check = () => { if (navigator.onLine) registration.update().catch(() => {}); };
    check();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) check();
    });
    window.addEventListener("pageshow", check);
  }).catch(() => {});
}


// Copias completas de AZORES (datos del navegador, no sincronización)
(function(){
 const exportButton=document.getElementById("exportBackup"), importButton=document.getElementById("importBackup"), fileInput=document.getElementById("backupFile");
 const backupFormat="azores-backup-v1";
 function validFinance(f){
  return f&&typeof f==="object"&&!Array.isArray(f)&&f.opening&&typeof f.opening==="object"&&
   ["Aurora","Pedro"].every(k=>Number.isFinite(Number(f.opening[k]??0)))&&
   ["contributions","withdrawals","capitalRepayments"].every(k=>f[k]===undefined||Array.isArray(f[k]));
 }
 function validProduct(p){return p&&typeof p==="object"&&!Array.isArray(p)&&typeof p.id==="string"&&p.id.length>0&&typeof p.name==="string"&&Number.isFinite(Number(p.purchasePrice??0));}
 exportButton.addEventListener("click",()=>{
  try{
   const data={format:backupFormat,exportedAt:new Date().toISOString(),products:JSON.parse(JSON.stringify(products)),finances:finances};
   if(!Array.isArray(data.products)||!data.products.every(validProduct)||!validFinance(data.finances))throw Error("Los datos actuales no tienen un formato válido");
   const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
   const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="AZORES_copia_"+new Date().toISOString().slice(0,10)+".json";document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
  }catch(e){alert("No se ha podido generar la copia: "+e.message)}
 });
 importButton.addEventListener("click",()=>{fileInput.value="";fileInput.click()});
 fileInput.addEventListener("change",async()=>{
  const file=fileInput.files?.[0];if(!file)return;
  try{
   if(file.size>30*1024*1024)throw Error("La copia supera 30 MB. Contacta antes de restaurarla.");
   const data=JSON.parse(await file.text());
   if(data?.format!==backupFormat||!Array.isArray(data.products)||!data.products.every(validProduct)||!validFinance(data.finances))throw Error("El archivo no es una copia compatible de AZORES");
   const ids=data.products.map(p=>p.id);if(new Set(ids).size!==ids.length)throw Error("La copia contiene identificadores duplicados");
   const oldProducts=localStorage.getItem(KEY),oldFinances=localStorage.getItem(FIN_KEY);
   const ok=confirm("ATENCIÓN: Restaurar esta copia sustituirá TODAS las compras, ventas, envíos y cuentas guardados actualmente en este navegador. ¿Has descargado antes una copia de los datos actuales?\n\nCopia: "+data.products.length+" productos, creada "+(data.exportedAt||"fecha desconocida")+".\n\n¿Quieres continuar?");
   if(!ok)return;
   try{
    localStorage.setItem(KEY,JSON.stringify(data.products));
    localStorage.setItem(FIN_KEY,JSON.stringify(data.finances));
   }catch(e){
    try{if(oldProducts===null)localStorage.removeItem(KEY);else localStorage.setItem(KEY,oldProducts);if(oldFinances===null)localStorage.removeItem(FIN_KEY);else localStorage.setItem(FIN_KEY,oldFinances)}catch(_){}
    throw Error("No hay espacio suficiente en el almacenamiento del navegador. No se ha podido completar la restauración.");
   }
   products=data.products;finances=data.finances;
   finances.opening ||= {Aurora:0,Pedro:0};finances.contributions ||= [];finances.withdrawals ||= [];finances.capitalRepayments ||= [];
   render();queueCloudSave();alert("Copia restaurada. Comprueba Compras, Cuentas y Beneficios. Espera a que indique sincronizado antes de cerrar.");
  }catch(e){alert("No se ha restaurado la copia: "+e.message)}
 });
})();

// Visor de fotografías: no modifica los datos ni las imágenes almacenadas.
(function(){
 const viewer=document.createElement("dialog");
 viewer.className="azores-photo-viewer";
 viewer.setAttribute("aria-label","Fotografía ampliada del producto");
 viewer.innerHTML='<button type="button" class="azores-photo-close" aria-label="Cerrar fotografía">×</button><img alt="Fotografía ampliada">';
 document.body.appendChild(viewer);
 const close=()=>viewer.close();
 viewer.querySelector("button").addEventListener("click",close);
 viewer.addEventListener("click",e=>{if(e.target===viewer)close()});
 document.addEventListener("click",e=>{const photo=e.target.closest("img.zoomable-photo");if(!photo)return;viewer.querySelector("img").src=photo.src;viewer.querySelector("img").alt=photo.alt;viewer.showModal()});
 document.addEventListener("keydown",e=>{if((e.key==="Enter"||e.key===" ")&&e.target.matches("img.zoomable-photo")){e.preventDefault();e.target.click()}});
})();
