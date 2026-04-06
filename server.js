const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const path=require('path');

const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:'*'}});
app.use(express.static(path.join(__dirname,'public')));

// ── Constants ─────────────────────────────────────────────────
const GW=7200,GH=7200,TICK_MS=33,FOOD_COUNT=1200,BOT_COUNT=20;
const BMIN=600,BMAX=6600; // 6000x6000 play zone centered in 7200x7200 map
const ITEM_MAX=6,AOI_RANGE=5000;
const LERP_B=0.35,FRIC=0.80; // bots only - players use direct velocity

const rnd=(a,b)=>Math.random()*(b-a)+a;
const dst2=(ax,ay,bx,by)=>(ax-bx)*(ax-bx)+(ay-by)*(ay-by);
const mtr=m=>Math.sqrt(m)*1.5+3;
const clamp=(v,a,b)=>v<a?a:v>b?b:v;

// Speed decreases smoothly with mass (continuous curve, not discrete steps)
// Inspired by agar.io: larger = slower, smaller = faster
// mass=20 → 7px/tick, mass=200 → 3.7, mass=1000 → 2.3, mass=5000 → 1.5
// Speed tiers (each tier reduces by % vs previous):
// <1000: 100% | 1000-1999: -20% | 2000-4999: -20% | 5000-9999: -10% | 10000+: -10%
function speedMult(m){
  if(m>=10000)return 0.5184; // 100*0.8*0.8*0.9*0.9
  if(m>=5000) return 0.576;  // 100*0.8*0.8*0.9
  if(m>=2000) return 0.640;  // 100*0.8*0.8
  if(m>=1000) return 0.800;  // 100*0.8
  return 1.000;              // 100%
}
function baseSpd(m){return 8*speedMult(m);} // 8px/tick base at mass<1000

// ── Spatial grid ──────────────────────────────────────────────
const CELL=500;
const GC=Math.ceil(GW/CELL),GR=Math.ceil(GH/CELL);
const grid=Array.from({length:GC},()=>Array.from({length:GR},()=>new Set()));
function gc(x,y){return[clamp(0|x/CELL,0,GC-1),clamp(0|y/CELL,0,GR-1)];}
function gadd(i){const[c,r]=gc(food[i].x,food[i].y);grid[c][r].add(i);}
function grem(i){const[c,r]=gc(food[i].x,food[i].y);grid[c][r].delete(i);}
function gbuild(){for(let c=0;c<GC;c++)for(let r=0;r<GR;r++)grid[c][r].clear();for(let i=0;i<food.length;i++)gadd(i);}
function gnear(x,y,rad){
  const res=[],c0=clamp(0|(x-rad)/CELL,0,GC-1),c1=clamp(0|(x+rad)/CELL,0,GC-1),
    r0=clamp(0|(y-rad)/CELL,0,GR-1),r1=clamp(0|(y+rad)/CELL,0,GR-1);
  for(let c=c0;c<=c1;c++)for(let r=r0;r<=r1;r++)for(const i of grid[c][r])res.push(i);
  return res;
}

// ── Food & Items ──────────────────────────────────────────────
const FSIZES=[{mass:5,r:3,w:30},{mass:10,r:4,w:25},{mass:20,r:5,w:20},{mass:50,r:7,w:15},{mass:100,r:10,w:10}];
function mkFood(){
  const roll=Math.random()*100;let acc=0;
  for(const ft of FSIZES){acc+=ft.w;if(roll<acc)return{x:rnd(BMIN+30,BMAX-30),y:rnd(BMIN+30,BMAX-30),mass:ft.mass,r:ft.r,col:`hsl(${0|rnd(0,360)},80%,65%)`};}
  return{x:rnd(BMIN+30,BMAX-30),y:rnd(BMIN+30,BMAX-30),mass:5,r:3,col:'#aaa'};
}
function eatFood(i){grem(i);food[i]=mkFood();gadd(i);}

const ITYPES=['DASH','SHIELD','STEALTH','GROW','MAGNET','TOXIC','BOMB','BULLET'];
const ICOLS={DASH:'#0cf',SHIELD:'#88f',STEALTH:'#ccc',GROW:'#4f4',MAGNET:'#f0f',TOXIC:'#8f0',BOMB:'#f80',BULLET:'#ff4'};
function spawnItem(t){
  if(items.filter(x=>x.type===t).length>=ITEM_MAX)return;
  items.push({id:uid(),x:rnd(BMIN+200,BMAX-200),y:rnd(BMIN+200,BMAX-200),type:t,r:28,col:ICOLS[t],label:t,pickup:t!=='TOXIC'});
  io.emit('itemAdded',items[items.length-1]);
}
function schedItem(t){setTimeout(()=>spawnItem(t),15000);}

// ── Bots ──────────────────────────────────────────────────────
const BNAMES=['Orion','Lyra','Nebula','Vega','Pulsar','Quasar','Sirius','Nova','Titan','Andromeda','Zeta','Rigel','Spica','Altair','Deneb'];
const BCOLS=['#f55','#f90','#ff4','#4f4','#4cf','#f4f','#fa4','#5fa','#f5a','#af5','#5af','#ff8','#f64','#6f4','#46f'];
function mkBot(i){
  return{id:'b'+i,x:rnd(BMIN+300,BMAX-300),y:rnd(BMIN+300,BMAX-300),mass:20,vx:0,vy:0,_dashing:0,
    col:BCOLS[i%15],name:BNAMES[i%15]+(i>=15?'_'+(i/15|0):''),
    atx:rnd(0,GW),aty:rnd(0,GH),at:rnd(0,1500),st:rnd(0,7)};
}

// ── Players ───────────────────────────────────────────────────
function mkPlayer(id,name,color,flag){
  return{id,name:name||'Player',color:color||'#00cfff',flag:flag||null,
    x:rnd(BMIN+300,BMAX-300),y:rnd(BMIN+300,BMAX-300),mass:20,vx:0,vy:0,
    shieldEnd:Date.now()+5000,stealthEnd:0,_dashFrames:0,
    inv:{dash:0,shield:0,stealth:0,bomb:0,magnet:0,bullet:0},bulletEnd:0,
    cdQ:0,cdW:0,cdR:0,cdB:0,cdF:0,_lastShot:0,
    inputVx:0,inputVy:0};
}

// ── State ─────────────────────────────────────────────────────
let players={},bots=[],food=[],items=[],bullets=[];
let _id=0;const uid=()=>(++_id).toString(36);

function initWorld(){
  food=Array.from({length:FOOD_COUNT},mkFood);
  items=[];ITYPES.forEach(t=>{for(let i=0;i<ITEM_MAX;i++)spawnItem(t);});
  bots=Array.from({length:BOT_COUNT},(_,i)=>mkBot(i));
  bullets=[];gbuild();
}

// ── Bullet pool ───────────────────────────────────────────────
const POOL=Array.from({length:300},()=>({active:false}));
function getBullet(props){
  let b=POOL.find(x=>!x.active)||{active:false};
  return Object.assign(b,props,{active:true});
}

// ── Sockets ───────────────────────────────────────────────────
io.on('connection',sock=>{
  sock.on('join',({name,color,flag})=>{
    const p=mkPlayer(sock.id,name,color,flag);
    players[sock.id]=p;
    sock.emit('init',{id:sock.id,food,items,bots:bots.map(b=>({id:b.id,x:b.x,y:b.y,mass:b.mass,col:b.col,name:b.name})),worldW:GW,worldH:GH});
    io.emit('playerList',pList());
  });

  sock.on('input',({vx,vy})=>{
    const p=players[sock.id];if(!p)return;
    p.inputVx=clamp(vx,-1,1);p.inputVy=clamp(vy,-1,1);
  });

  sock.on('dash',({nx,ny})=>{
    const p=players[sock.id];if(!p||p.inv.dash<=0)return;
    p.inv.dash--;
    // Smooth dash: high velocity burst decays naturally each tick
    // 200px target: vx=40px/tick, decays ~5 ticks = smooth slide
    const dashSpd=82; // vx=82, 12 ticks, decay=0.82 -> ~403px from edge
    p.vx=nx*dashSpd;
    p.vy=ny*dashSpd;
    p._dashing=12;
  });
  sock.on('shield',()=>{
    const p=players[sock.id];if(!p||p.inv.shield<=0||p.cdW>0)return;
    p.inv.shield--;p.cdW=3000;p.shieldEnd=Date.now()+3000;
  });
  sock.on('stealth',()=>{
    const p=players[sock.id];if(!p||p.inv.stealth<=0||p.cdR>0)return;
    p.inv.stealth--;p.cdR=5000;p.stealthEnd=Date.now()+5000;
  });
  sock.on('bomb',({nx,ny})=>{
    const p=players[sock.id];if(!p||p.inv.bomb<=0||p.cdB>0)return;
    p.inv.bomb--;p.cdB=1500;const r=mtr(p.mass);
    bullets.push(getBullet({id:uid(),x:p.x+nx*(r+5),y:p.y+ny*(r+5),vx:nx*16,vy:ny*16,type:'bomb',r:14,life:32,col:'#f80',owner:sock.id}));
  });
  sock.on('magnet',()=>{
    const p=players[sock.id];if(!p||p.inv.magnet<=0||p.cdF>0)return;
    p.inv.magnet--;p.cdF=1000;
    const rad=mtr(p.mass)+300,rad2=rad*rad,near=gnear(p.x,p.y,rad);let n=0;
    near.forEach(i=>{if(dst2(p.x,p.y,food[i].x,food[i].y)<rad2){p.mass=Math.min(10000,p.mass+food[i].mass);eatFood(i);n++;}});
    sock.emit('msg',{text:'MAGNET: +'+n+' food',col:'#f0f'});
  });
  sock.on('shoot',({nx,ny,px,py})=>{
    const p=players[sock.id];if(!p||p.mass<=20)return;
    const now=Date.now();if(now-p._lastShot<250)return;
    p._lastShot=now;p.mass-=1;const r=mtr(p.mass);
    // Use client predicted position if close to server pos (< 200px)
    const sx=(px!==undefined&&Math.hypot(px-p.x,py-p.y)<200)?px:p.x;
    const sy=(py!==undefined&&Math.hypot(px-p.x,py-p.y)<200)?py:p.y;
    // Primary bullet - from front edge facing cursor
    bullets.push(getBullet({id:uid(),x:sx+nx*(r+5),y:sy+ny*(r+5),vx:nx*16,vy:ny*16,type:'shot',r:3,life:32,col:p.color,owner:sock.id}));
    // BULLET item: activate when shooting if have stack (consume 1 per use, 10s timer)
    if(p.inv.bullet>0&&now>=p.bulletEnd){p.inv.bullet--;p.bulletEnd=now+10000;}
    if(now<p.bulletEnd){
      const perp_x=-ny,perp_y=nx; // perpendicular vector
      const sp=22;
      bullets.push(getBullet({id:uid(),x:sx+perp_x*sp+nx*(r+5),y:sy+perp_y*sp+ny*(r+5),vx:nx*16,vy:ny*16,type:'shot',r:3,life:32,col:'#ff4',owner:sock.id}));
      bullets.push(getBullet({id:uid(),x:sx-perp_x*sp+nx*(r+5),y:sy-perp_y*sp+ny*(r+5),vx:nx*16,vy:ny*16,type:'shot',r:3,life:32,col:'#ff4',owner:sock.id}));
    }
  });
  sock.on('ping',()=>sock.emit('pong',Date.now()));
  sock.on('disconnect',()=>{delete players[sock.id];io.emit('playerLeft',sock.id);io.emit('playerList',pList());});
});

function pList(){return Object.values(players).map(p=>({id:p.id,name:p.name,mass:Math.floor(p.mass)})).sort((a,b)=>b.mass-a.mass);}

// ── Physics ───────────────────────────────────────────────────
const pending=[];
function qe(ev,d){pending.push({ev,d,to:null});}
function qet(id,ev,d){pending.push({ev,d,to:id});}

function respawnPlayer(p,by){
  qet(p.id,'died',{by});
  p.mass=20;p.x=rnd(BMIN+300,BMAX-300);p.y=rnd(BMIN+300,BMAX-300);
  p.vx=0;p.vy=0;p.shieldEnd=Date.now()+5000;
}

function tick(){
  const now=Date.now();
  physics(now);
  broadcast(now);
  const spent=Date.now()-now;
  setTimeout(tick,Math.max(0,TICK_MS-spent));
}

function physics(now){
  const PA=Object.values(players),PL=PA.length,BL=bots.length;
  const lB=1-Math.pow(1-LERP_B,1),fr=Math.pow(FRIC,1); // bots only

  // Players
  for(let i=0;i<PL;i++){
    const p=PA[i];
    if(p.cdQ>0)p.cdQ-=TICK_MS;if(p.cdW>0)p.cdW-=TICK_MS;
    if(p.cdR>0)p.cdR-=TICK_MS;if(p.cdB>0)p.cdB-=TICK_MS;if(p.cdF>0)p.cdF-=TICK_MS;
    const spd=baseSpd(p.mass);
    // Direct velocity (or dash momentum if dashing)
    if(p._dashing>0){
      p._dashing--;
      // Preserve dash velocity, decay naturally
      p.vx*=0.82;p.vy*=0.82;
    } else {
      p.vx=p.inputVx*spd;
      p.vy=p.inputVy*spd;
    }
    const pr=mtr(p.mass);
        p.x=clamp(p.x+p.vx,BMIN+pr,BMAX-pr);p.y=clamp(p.y+p.vy,BMIN+pr,BMAX-pr);
    p.mass=clamp(p.mass,10,10000);
    // Eat food — use exact server position, no drift hacks needed
    const nr=gnear(p.x,p.y,pr+20);
    for(const fi of nr){
      const f=food[fi];
      if(p.mass>=f.mass&&dst2(p.x,p.y,f.x,f.y)<(pr+f.r)*(pr+f.r)){
        p.mass=Math.min(10000,p.mass+f.mass);eatFood(fi);
        io.emit('foodEaten',{ni:fi,nf:food[fi]});
      }
    }
    // Eat items
    for(let j=items.length-1;j>=0;j--){
      const it=items[j];if(!it.pickup)continue;
      if(p.mass>=100&&dst2(p.x,p.y,it.x,it.y)<(pr+it.r)*(pr+it.r)){ // eat on visual touch
        if(it.type==='DASH')p.inv.dash++;
        else if(it.type==='SHIELD')p.inv.shield++;
        else if(it.type==='STEALTH')p.inv.stealth++;
        else if(it.type==='GROW')p.mass=Math.min(10000,p.mass*2);  // double mass
        else if(it.type==='MAGNET')p.inv.magnet++;
        else if(it.type==='BOMB')p.inv.bomb++;
        else if(it.type==='BULLET')p.inv.bullet++; // activate on shoot (E key)
        const{type,id}=it;items.splice(j,1);schedItem(type);
        io.emit('itemRemoved',id);
      }
    }
    // Toxic aura
    items.forEach(it=>{if(it.type==='TOXIC'&&dst2(p.x,p.y,it.x,it.y)<15000)p.mass=Math.max(10,p.mass*0.999);});
  }

  // PvP
  for(let i=0;i<PL;i++){
    const p=PA[i],pr=mtr(p.mass),pr2=pr*pr;
    for(let j=0;j<PL;j++){
      if(i===j)continue;const q=PA[j];
      if(now<q.shieldEnd||now<q.stealthEnd)continue;
      if(p.mass>q.mass*1.1&&dst2(p.x,p.y,q.x,q.y)<pr2){
        p.mass=Math.min(10000,p.mass+q.mass*0.7);
        qe('explode',{x:q.x,y:q.y,col:q.color});
        qe('msg',{text:p.name+' ate '+q.name+'!',col:'#0ff'});
        respawnPlayer(q,p.name);
      }
    }
  }

  // Bullets
  for(let i=bullets.length-1;i>=0;i--){
    const b=bullets[i];b.x+=b.vx;b.y+=b.vy;b.life--;
    if(b.life<=0||b.x<0||b.x>GW||b.y<0||b.y>GH){b.active=false;bullets.splice(i,1);continue;}
    let hit=false;
    for(let j=0;j<PL&&!hit;j++){
      const p=PA[j];if(p.id===b.owner||now<p.shieldEnd)continue;
      if(dst2(b.x,b.y,p.x,p.y)<(b.r+mtr(p.mass))*(b.r+mtr(p.mass))){
        b.type==='bomb'?p.mass=Math.max(15,p.mass*0.7):p.mass=Math.max(15,p.mass-5);
        const dl=Math.hypot(b.vx,b.vy)||1;
        qe('explode',{x:p.x,y:p.y,nx:b.vx/dl,ny:b.vy/dl,r:mtr(p.mass),col:b.col});
        b.active=false;bullets.splice(i,1);hit=true;
        if(p.mass<20)respawnPlayer(p,'bullet');
      }
    }
    if(hit)continue;
    for(let j=0;j<BL&&!hit;j++){
      const bot=bots[j];if(bot.id===b.owner)continue;
      if(dst2(b.x,b.y,bot.x,bot.y)<(b.r+mtr(bot.mass))*(b.r+mtr(bot.mass))){
        b.type==='bomb'?bot.mass=Math.max(5,bot.mass*0.7):bot.mass=Math.max(5,bot.mass-5);
        const dl=Math.hypot(b.vx,b.vy)||1;
        qe('explode',{x:bot.x,y:bot.y,nx:b.vx/dl,ny:b.vy/dl,r:mtr(bot.mass),col:b.col});
        b.active=false;bullets.splice(i,1);hit=true;
        if(bot.mass<20){bot.mass=20;bot.x=rnd(BMIN+300,BMAX-300);bot.y=rnd(BMIN+300,BMAX-300);}
      }
    }
  }

  // Bots AI + movement
  for(let i=0;i<BL;i++){
    const bot=bots[i];
    bot.at-=TICK_MS;bot.st--;
    if(bot.at<=0){
      bot.at=rnd(400,1200);
      let best=null,bs=-Infinity,fx=0,fy=0,flee=false;
      for(let j=0;j<PL;j++){
        const p=PA[j];if(now<p.stealthEnd)continue;
        const d2=dst2(bot.x,bot.y,p.x,p.y);
        if(p.mass>bot.mass*1.1&&d2<90000){const d=Math.sqrt(d2)||1;fx+=(bot.x-p.x)/d;fy+=(bot.y-p.y)/d;flee=true;}
      }
      if(flee){const fl=Math.hypot(fx,fy)||1;bot.atx=clamp(bot.x+fx/fl*500,BMIN+100,BMAX-100);bot.aty=clamp(bot.y+fy/fl*500,BMIN+100,BMAX-100);}
      else{
        const nf=gnear(bot.x,bot.y,600);
        nf.forEach(fi=>{const f=food[fi];if(bot.mass>f.mass){const s=f.mass/(Math.hypot(bot.x-f.x,bot.y-f.y)+1);if(s>bs){bs=s;best=f;}}});
        for(let j=0;j<PL;j++){
          const p=PA[j];if(now<p.stealthEnd||bot.mass<=p.mass*1.1)continue;
          const d2=dst2(bot.x,bot.y,p.x,p.y);
          if(d2<200000){const s=600/(Math.sqrt(d2)+1);if(s>bs){bs=s;best=p;}}
        }
        bot.atx=best?best.x:rnd(100,GW-100);bot.aty=best?best.y:rnd(100,GH-100);
      }
    }
    const dx=bot.atx-bot.x,dy=bot.aty-bot.y,dl=Math.hypot(dx,dy)||1,spd=baseSpd(bot.mass);
    bot.vx+=(dx/dl*spd-bot.vx)*lB;bot.vy+=(dy/dl*spd-bot.vy)*lB;bot.vx*=fr;bot.vy*=fr;
    const br=mtr(bot.mass);
    bot.x=clamp(bot.x+bot.vx,BMIN+br,BMAX-br);bot.y=clamp(bot.y+bot.vy,BMIN+br,BMAX-br);
    // Bot eat food
    gnear(bot.x,bot.y,br+10).forEach(fi=>{
      const f=food[fi];
      if(bot.mass>=f.mass&&dst2(bot.x,bot.y,f.x,f.y)<(br+f.r)*(br+f.r)){bot.mass=Math.min(10000,bot.mass+f.mass);eatFood(fi);}
    });
    // Bot vs player
    for(let j=0;j<PL;j++){
      const p=PA[j];if(now<p.shieldEnd)continue;
      if(bot.mass>p.mass*1.1&&dst2(bot.x,bot.y,p.x,p.y)<br*br){
        bot.mass=Math.min(10000,bot.mass+p.mass*0.7);
        qe('explode',{x:p.x,y:p.y,col:p.color});
        respawnPlayer(p,bot.name);
      }
      const pr=mtr(p.mass);
      if(p.mass>bot.mass*1.1&&dst2(p.x,p.y,bot.x,bot.y)<(pr+mtr(bot.mass))*(pr+mtr(bot.mass))){
        p.mass=Math.min(10000,p.mass+bot.mass*0.7);
        qe('explode',{x:bot.x,y:bot.y,col:bot.col});
        bot.mass=20;bot.x=rnd(BMIN+300,BMAX-300);bot.y=rnd(BMIN+300,BMAX-300);
      }
    }
    // Bot shoot
    if(bot.st<=0&&bot.mass>20){
      bot.st=7;
      for(let j=0;j<PL;j++){
        const p=PA[j];if(now<p.stealthEnd)continue;
        const d2=dst2(bot.x,bot.y,p.x,p.y);
        if(d2>1&&d2<200000){
          const d=Math.sqrt(d2),nx=(p.x-bot.x)/d,ny=(p.y-bot.y)/d;
          bullets.push(getBullet({id:uid(),x:bot.x+nx*(br+5),y:bot.y+ny*(br+5),vx:nx*16,vy:ny*16,type:'shot',r:3,life:32,col:bot.col,owner:bot.id}));
          bot.mass=Math.max(5,bot.mass-1);
        }
      }
    }
    if(bot.mass<20){bot.mass=20;bot.x=rnd(BMIN+300,BMAX-300);bot.y=rnd(BMIN+300,BMAX-300);}
  }

  // Flush events
  for(const e of pending){e.to?io.to(e.to).emit(e.ev,e.d):io.emit(e.ev,e.d);}
  pending.length=0;
}

function broadcast(now){
  const PA=Object.values(players),PL=PA.length,BL=bots.length,aoi2=AOI_RANGE*AOI_RANGE;
  for(let i=0;i<PL;i++){
    const p=PA[i],sock=io.sockets.sockets.get(p.id);if(!sock)continue;
    const vP=[],vB=[],vU=[];
    for(let j=0;j<PL;j++){
      const q=PA[j];
      if(j!==i&&dst2(p.x,p.y,q.x,q.y)>=aoi2)continue;
      vP.push({i:q.id,n:q.name,c:q.color,f:q.flag,x:Math.round(q.x),y:Math.round(q.y),m:Math.round(q.mass),sh:now<q.shieldEnd?1:0,st:now<q.stealthEnd?1:0,inv:q.inv,cQ:q.cdQ,cW:q.cdW,cR:q.cdR,cB:q.cdB,cF:q.cdF,bE:q.bulletEnd});
    }
    for(let j=0;j<BL;j++){
      const b=bots[j];if(dst2(p.x,p.y,b.x,b.y)<aoi2)vB.push({i:b.id,x:Math.round(b.x),y:Math.round(b.y),m:Math.round(b.mass),c:b.col,n:b.name});
    }
    for(let j=0;j<bullets.length;j++){
      const b=bullets[j];if(dst2(p.x,p.y,b.x,b.y)<aoi2)vU.push({i:b.id,x:Math.round(b.x),y:Math.round(b.y),r:b.r,c:b.col,t:b.type==='bomb'?1:0});
    }
    sock.emit('state',{t:now,p:vP,b:vB,u:vU});
  }
}

setTimeout(tick,TICK_MS);
// worldUpdate removed - was sending 87KB every 5s causing event loop spike
// Food is synced via init + foodEaten events instead
// Items synced via itemAdded + itemRemoved events
setInterval(()=>io.emit('playerList',pList()),3000);

initWorld();
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('SpaceCell at http://localhost:'+PORT));
