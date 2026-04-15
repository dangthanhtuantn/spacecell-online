const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const path=require('path');

const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:'*'}});
app.use(express.static(path.join(__dirname,'public')));

// ── Constants ─────────────────────────────────────────────────
const GW=7200,GH=7200,TICK_MS=33,FOOD_COUNT=1200;
const BMIN=600,BMAX=6600; // 6000x6000 play zone
const ITEM_MAX=6,AOI_RANGE=3000;

const rnd=(a,b)=>Math.random()*(b-a)+a;
const dst2=(ax,ay,bx,by)=>(ax-bx)*(ax-bx)+(ay-by)*(ay-by);
const mtr=m=>Math.sqrt(m)*1.5+3;
const clamp=(v,a,b)=>v<a?a:v>b?b:v;

function speedMult(m){
  if(m>=10000)return 0.5184;
  if(m>=5000) return 0.576;
  if(m>=2000) return 0.640;
  if(m>=1000) return 0.800;
  return 1.000;
}
function baseSpd(m){return 8*speedMult(m);}

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
const FSIZES=[{mass:1,r:3,w:30},{mass:2,r:4,w:25},{mass:3,r:5,w:20},{mass:5,r:7,w:15},{mass:10,r:10,w:10}];
function mkFood(){
  const roll=Math.random()*100;let acc=0;
  for(const ft of FSIZES){acc+=ft.w;if(roll<acc)return{x:rnd(BMIN+30,BMAX-30),y:rnd(BMIN+30,BMAX-30),mass:ft.mass,r:ft.r,col:`hsl(${0|rnd(0,360)},80%,65%)`};}
  return{x:rnd(BMIN+30,BMAX-30),y:rnd(BMIN+30,BMAX-30),mass:5,r:3,col:'#aaa'};
}
function eatFood(i){grem(i);food[i]=mkFood();gadd(i);}

const ITYPES=['SPEED','SHIELD','STEALTH','GROW','MAGNET','TOXIC','BOMB','BULLET'];
const ICOLS={SPEED:'#0ff',SHIELD:'#88f',STEALTH:'#ccc',GROW:'#4f4',MAGNET:'#f0f',TOXIC:'#8f0',BOMB:'#f80',BULLET:'#ff4'};
function spawnItem(t){
  if(items.filter(x=>x.type===t).length>=ITEM_MAX)return;
  items.push({id:uid(),x:rnd(BMIN+200,BMAX-200),y:rnd(BMIN+200,BMAX-200),type:t,r:28,col:ICOLS[t],label:t,pickup:t!=='TOXIC'});
  io.emit('itemAdded',items[items.length-1]);
}
function schedItem(t){setTimeout(()=>spawnItem(t),15000);}

// ── Bots ──────────────────────────────────────────────────────
const BNAMES=['Orion','Lyra','Nebula','Vega','Pulsar','Quasar','Sirius','Nova','Titan','Andromeda','Zeta','Rigel','Spica','Altair','Deneb'];
const BCOLS=['#f55','#f90','#ff4','#4f4','#4cf','#f4f','#fa4','#5fa','#f5a','#af5','#5af','#ff8','#f64','#6f4','#46f'];
function mkBot(i,mass=500){
  return{id:'b'+i,x:rnd(BMIN+300,BMAX-300),y:rnd(BMIN+300,BMAX-300),mass,_initMass:mass,vx:0,vy:0,
    col:BCOLS[i%15],name:BNAMES[i%15]+(i>=15?'_'+(i/15|0):''),
    atx:rnd(BMIN+100,BMAX-100),aty:rnd(BMIN+100,BMAX-100),at:rnd(0,1000),st:rnd(0,7)};
}

// ── Players ───────────────────────────────────────────────────
function mkPlayer(id,name,color,flag){
  return{id,name:name||'Player',color:color||'#00cfff',flag:flag||null,
    x:rnd(BMIN+300,BMAX-300),y:rnd(BMIN+300,BMAX-300),mass:300,vx:0,vy:0,
    shieldEnd:Date.now()+5000,stealthEnd:0,_dashing:0,
    inv:{speed:0,shield:0,stealth:0,bomb:0,magnet:0,bullet:0},
    speedEnd:0,magnetEnd:0,bulletEnd:0,
    cdQ:0,cdW:0,cdR:0,cdB:0,_lastShot:0,
    inputVx:0,inputVy:0};
}

// ── State ─────────────────────────────────────────────────────
let players={},bots=[],food=[],items=[],bullets=[],spectators=new Set();
let _id=0;const uid=()=>(++_id).toString(36);

function initWorld(){
  food=Array.from({length:FOOD_COUNT},mkFood);
  items=[];ITYPES.forEach(t=>{for(let i=0;i<ITEM_MAX;i++)spawnItem(t);});
  const botConfig=[
    ...Array(1).fill(500),...Array(2).fill(1000),
    ...Array(4).fill(2000),...Array(2).fill(5000),...Array(1).fill(10000)
  ];
  bots=botConfig.map((mass,i)=>mkBot(i,mass));
  bullets=[];gbuild();
}

// ── Sockets ───────────────────────────────────────────────────
io.on('connection',sock=>{
  sock.on('join',({name,color,flag})=>{
    const p=mkPlayer(sock.id,name,color,flag);
    players[sock.id]=p;
    sock.emit('init',{id:sock.id,food,items,bots:bots.map(b=>({id:b.id,x:b.x,y:b.y,mass:b.mass,col:b.col,name:b.name})),worldW:GW,worldH:GH});
    io.emit('playerList',pList());
  });
  sock.on('input',({vx,vy})=>{const p=players[sock.id];if(!p)return;p.inputVx=clamp(vx,-1,1);p.inputVy=clamp(vy,-1,1);});
  sock.on('speed',()=>{const p=players[sock.id];if(!p||p.inv.speed<=0)return;p.inv.speed--;p.speedEnd=Date.now()+2000;});
  sock.on('shield',()=>{const p=players[sock.id];if(!p||p.inv.shield<=0)return;p.inv.shield--;p.shieldEnd=Date.now()+5000;});
  sock.on('stealth',()=>{const p=players[sock.id];if(!p||p.inv.stealth<=0)return;p.inv.stealth--;p.stealthEnd=Date.now()+5000;});
  sock.on('bomb',({nx,ny})=>{
    const p=players[sock.id];if(!p||p.inv.bomb<=0||p.cdB>0)return;
    p.inv.bomb--;p.cdB=1500;const r=mtr(p.mass);
    bullets.push({id:uid(),x:p.x+nx*(r+14),y:p.y+ny*(r+14),vx:nx*16,vy:ny*16,type:'bomb',r:14,life:64,col:'#f80',owner:sock.id,dmg:0});
  });
  sock.on('shoot',({nx,ny})=>{
    const p=players[sock.id];if(!p||p.mass<=100)return;
    const now=Date.now();
    const bulletActive=now<p.bulletEnd;
    if(now-p._lastShot<(bulletActive?125:250))return;
    p._lastShot=now;p.mass-=1;const r=mtr(p.mass);
    const dmg=bulletActive?30:10;
    bullets.push({id:uid(),x:p.x+nx*(r+3),y:p.y+ny*(r+3),vx:nx*16,vy:ny*16,type:'shot',r:3,life:64,col:p.color,owner:sock.id,dmg});
    if(p.inv.bullet>0&&now>=p.bulletEnd){p.inv.bullet--;p.bulletEnd=now+10000;}
    if(bulletActive){
      const bpx=-ny,bpy=nx;
      bullets.push({id:uid(),x:p.x+bpx*22+nx*(r+3),y:p.y+bpy*22+ny*(r+3),vx:nx*16,vy:ny*16,type:'shot',r:3,life:64,col:'#ff4',owner:sock.id,dmg});
      bullets.push({id:uid(),x:p.x-bpx*22+nx*(r+3),y:p.y-bpy*22+ny*(r+3),vx:nx*16,vy:ny*16,type:'shot',r:3,life:64,col:'#ff4',owner:sock.id,dmg});
    }
  });
  let _chatCd=0;
  let _spectatorName=null,_spectatorCol='#aaa';
  sock.on('chat',({text})=>{
    if(!text)return;
    const now=Date.now();if(now-_chatCd<2000)return;
    _chatCd=now;
    const clean=String(text).substring(0,60).replace(/[<>]/g,'');
    const p=players[sock.id];
    const name=p?p.name:(_spectatorName||'Viewer');
    const col=p?p.color:(_spectatorCol||'#aaa');
    io.emit('chat',{name,text:clean,col});
  });
  sock.on('spectate',({name,col}={})=>{
    _spectatorName=name||'Viewer';_spectatorCol=col||'#aaa';
    spectators.add(sock.id);broadcastViewerCount();
    sock.emit('init',{id:sock.id,food,items,bots:bots.map(b=>({id:b.id,x:b.x,y:b.y,mass:b.mass,col:b.col,name:b.name})),worldW:GW,worldH:GH});
  });

  sock.on('disconnect',()=>{delete players[sock.id];spectators.delete(sock.id);broadcastViewerCount();io.emit('playerLeft',sock.id);io.emit('playerList',pList());});
});

function pList(){return Object.values(players).map(p=>({id:p.id,name:p.name,mass:Math.floor(p.mass)})).sort((a,b)=>b.mass-a.mass);}
function broadcastViewerCount(){io.emit('viewerCount',spectators.size);}

// ── Physics ───────────────────────────────────────────────────
const pending=[];
function qe(ev,d){pending.push({ev,d,to:null});}
function qet(id,ev,d){pending.push({ev,d,to:id});}

function respawnPlayer(p,by){
  qet(p.id,'died',{by});
  p.mass=100;p.x=rnd(BMIN+300,BMAX-300);p.y=rnd(BMIN+300,BMAX-300);
  p.vx=0;p.vy=0;p.shieldEnd=Date.now()+5000;p.stealthEnd=0;p._dashing=0;
  p.inv={speed:0,shield:0,stealth:0,bomb:0,magnet:0,bullet:0};
  p.speedEnd=0;p.magnetEnd=0;p.bulletEnd=0;
  p.cdQ=0;p.cdW=0;p.cdR=0;p.cdB=0;p._lastShot=0;p.inputVx=0;p.inputVy=0;
}

// Inscribed circle: R eats r when R>r AND d <= R-r
function eats(R,r,d2){if(R<=r)return false;const g=R-r;return d2<=g*g;}

function tick(){
  const now=Date.now();
  try{physics(now);}catch(e){console.error('[physics]',e.message,e.stack);}
  try{broadcast(now);}catch(e){console.error('[broadcast]',e.message);}
  const spent=Date.now()-now;
  setTimeout(tick,Math.max(0,TICK_MS-spent));
}

function physics(now){
  const PA=Object.values(players),PL=PA.length,BL=bots.length;

  // ── Players ──────────────────────────────────────────────────
  for(let i=0;i<PL;i++){
    const p=PA[i];
    if(p.cdQ>0)p.cdQ-=TICK_MS;if(p.cdW>0)p.cdW-=TICK_MS;
    if(p.cdR>0)p.cdR-=TICK_MS;if(p.cdB>0)p.cdB-=TICK_MS;
    const speedMod=now<p.speedEnd?2:1;
    const spd=baseSpd(p.mass)*speedMod;
    if(p._dashing>0){p._dashing--;p.vx*=0.82;p.vy*=0.82;}
    else{p.vx=p.inputVx*spd;p.vy=p.inputVy*spd;}
    const pr=mtr(p.mass);
    p.x=clamp(p.x+p.vx,BMIN+pr,BMAX-pr);p.y=clamp(p.y+p.vy,BMIN+pr,BMAX-pr);
    p.mass=clamp(p.mass,10,10000);
    if(now<p.stealthEnd)continue; // stealthed: skip all eating
    // Eat food
    for(const fi of gnear(p.x,p.y,pr+15)){
      const f=food[fi];
      if(dst2(p.x,p.y,f.x,f.y)<(pr+f.r)*(pr+f.r)){
        p.mass=Math.min(10000,p.mass+f.mass);eatFood(fi);
        io.emit('foodEaten',{ni:fi,nf:food[fi]});
      }
    }
      // Eat items
    for(let j=items.length-1;j>=0;j--){
      const it=items[j];if(!it.pickup)continue;
      if(dst2(p.x,p.y,it.x,it.y)<(pr+it.r)*(pr+it.r)){
        if(it.type==='SPEED')p.inv.speed++;
        else if(it.type==='SHIELD')p.inv.shield++;
        else if(it.type==='STEALTH')p.inv.stealth++;
        else if(it.type==='GROW')p.mass=Math.min(10000,p.mass*1.1);
        else if(it.type==='MAGNET'){p.inv.magnet++;p.magnetEnd=now+5000;}
        else if(it.type==='BOMB')p.inv.bomb++;
        else if(it.type==='BULLET')p.inv.bullet++;
        io.emit('explode',{x:it.x,y:it.y,col:it.col,big:1,r:it.r});
        const{type,id}=it;items.splice(j,1);schedItem(type);
        io.emit('itemRemoved',id);
      }
    }
    // Toxic aura
    items.forEach(it=>{if(it.type==='TOXIC'&&dst2(p.x,p.y,it.x,it.y)<15000)p.mass=Math.max(10,p.mass*0.999);});
    // Magnet
    if(now<p.magnetEnd){
      const rad=mtr(p.mass)+133,near=gnear(p.x,p.y,rad);
      near.forEach(fi=>{if(dst2(p.x,p.y,food[fi].x,food[fi].y)<rad*rad){p.mass=Math.min(10000,p.mass+food[fi].mass);eatFood(fi);io.emit('foodEaten',{ni:fi,nf:food[fi]});}});
    }
  }

  // ── PvP ──────────────────────────────────────────────────────
  for(let i=0;i<PL;i++){
    const p=PA[i],pr=mtr(p.mass);
    if(now<p.stealthEnd)continue;
    for(let j=0;j<PL;j++){
      if(i===j)continue;const q=PA[j];
      if(now<q.shieldEnd||now<q.stealthEnd)continue;
      const qr=mtr(q.mass);
      if(eats(pr,qr,dst2(p.x,p.y,q.x,q.y))){
        p.mass=Math.min(10000,p.mass+q.mass*0.7);
        qe('explode',{x:q.x,y:q.y,col:q.color});
        qe('msg',{text:p.name+' ate '+q.name+'!',col:'#0ff'});
        respawnPlayer(q,p.name);
      }
    }
  }

  // ── Bullets ──────────────────────────────────────────────────
  for(let i=bullets.length-1;i>=0;i--){
    const b=bullets[i];b.x+=b.vx;b.y+=b.vy;b.life--;
    if(b.life<=0||b.x<BMIN||b.x>BMAX||b.y<BMIN||b.y>BMAX){bullets.splice(i,1);continue;}
    let hit=false;
    for(let j=0;j<PL&&!hit;j++){
      const p=PA[j];if(p.id===b.owner||now<p.shieldEnd)continue;
      if(dst2(b.x,b.y,p.x,p.y)<(b.r+mtr(p.mass))*(b.r+mtr(p.mass))){
        p.mass=b.type==='bomb'?Math.max(15,p.mass*0.5):Math.max(15,p.mass-(b.dmg||5));
        const dl=Math.hypot(b.vx,b.vy)||1;
        qe('explode',{x:p.x,y:p.y,nx:b.vx/dl,ny:b.vy/dl,r:mtr(p.mass),col:b.col});
        bullets.splice(i,1);hit=true;
        if(p.mass<100){qe('explode',{x:p.x,y:p.y,col:p.color,big:1});respawnPlayer(p,'bullet');}
      }
    }
    if(hit)continue;
    for(let j=0;j<BL&&!hit;j++){
      const bot=bots[j];if(bot.id===b.owner||bot._deadUntil)continue;
      if(dst2(b.x,b.y,bot.x,bot.y)<(b.r+mtr(bot.mass))*(b.r+mtr(bot.mass))){
        bot.mass=b.type==='bomb'?Math.max(1,bot.mass*0.5):Math.max(1,bot.mass-(b.dmg||5));
        const dl=Math.hypot(b.vx,b.vy)||1;
        qe('explode',{x:bot.x,y:bot.y,nx:b.vx/dl,ny:b.vy/dl,r:mtr(bot.mass),col:b.col});
        bullets.splice(i,1);hit=true;
        if(bot.mass<=100){
          qe('explode',{x:bot.x,y:bot.y,col:bot.col,big:1});
          bot._deadUntil=now+1500;bot.mass=1;bot.vx=0;bot.vy=0;
        }
      }
    }
  }

  // ── Bots ─────────────────────────────────────────────────────
  for(let i=0;i<BL;i++){
    const bot=bots[i];
    // Handle dead/respawn
    if(bot._deadUntil){
      if(now>=bot._deadUntil){
        bot._deadUntil=null;
        bot.mass=bot._initMass;
        bot.x=rnd(BMIN+300,BMAX-300);bot.y=rnd(BMIN+300,BMAX-300);
        bot.vx=0;bot.vy=0;bot.at=0; // immediately get new target
      } else continue;
    }
    bot.st--;
    const br=mtr(bot.mass);
    // AI: re-evaluate target when timer expires OR close to current target
    const distToTarget=dst2(bot.x,bot.y,bot.atx,bot.aty);
    bot.at-=TICK_MS;
    if(bot.at<=0||distToTarget<br*br*4){
      bot.at=rnd(800,2000);
      let fx=0,fy=0,flee=false,attackTarget=null,attackScore=-Infinity;
      for(let j=0;j<PL;j++){
        const p=PA[j];if(now<p.stealthEnd)continue;
        const d2=dst2(bot.x,bot.y,p.x,p.y);
        const d=Math.sqrt(d2)||1;
        if(mtr(p.mass)>br){ // player bigger
          if(d<1500){fx+=(bot.x-p.x)/d;fy+=(bot.y-p.y)/d;flee=true;}
        } else if(br>mtr(p.mass)){ // bot bigger
          if(d<2000){const score=1000/d;if(score>attackScore){attackScore=score;attackTarget=p;}}
        }
      }
      if(flee){
        const fl=Math.hypot(fx,fy)||1;
        bot._chaseId=null;
        bot.atx=clamp(bot.x+fx/fl*1200,BMIN+100,BMAX-100);
        bot.aty=clamp(bot.y+fy/fl*1200,BMIN+100,BMAX-100);
      } else if(attackTarget){
        bot.atx=attackTarget.x;bot.aty=attackTarget.y;
        bot._chaseId=attackTarget.id; // remember who we're chasing
      } else {
        // Wander randomly
        bot._chaseId=null;
        bot.atx=clamp(bot.x+rnd(-1500,1500),BMIN+100,BMAX-100);
        bot.aty=clamp(bot.y+rnd(-1500,1500),BMIN+100,BMAX-100);
      }
    }
    // Live track chased player position every tick
    if(bot._chaseId){
      const target=PA.find(p=>p.id===bot._chaseId);
      if(target&&mtr(target.mass)<br){bot.atx=target.x;bot.aty=target.y;}
      else bot._chaseId=null; // player got bigger or left - stop chasing
    }
    // Move toward target
    const dx=bot.atx-bot.x,dy=bot.aty-bot.y,dl=Math.hypot(dx,dy)||1;
    const spd=baseSpd(bot.mass);
    bot.vx+=(dx/dl*spd-bot.vx)*0.35;bot.vy+=(dy/dl*spd-bot.vy)*0.35;
    bot.vx*=0.80;bot.vy*=0.80;
    bot.x=clamp(bot.x+bot.vx,BMIN+br,BMAX-br);bot.y=clamp(bot.y+bot.vy,BMIN+br,BMAX-br);
    // Bot vs player
    for(let j=0;j<PL;j++){
      const p=PA[j];if(now<p.shieldEnd)continue;
      const pr=mtr(p.mass);
      if(eats(br,pr,dst2(bot.x,bot.y,p.x,p.y))){
        bot.mass=Math.min(10000,bot.mass+p.mass*0.7);
        qe('explode',{x:p.x,y:p.y,col:p.color});
        respawnPlayer(p,bot.name);
      } else if(eats(pr,br,dst2(p.x,p.y,bot.x,bot.y))){
        p.mass=Math.min(10000,p.mass+bot.mass*0.7);
        qe('explode',{x:bot.x,y:bot.y,col:bot.col,big:1,r:br});
        bot._deadUntil=now+1500;bot.mass=1;bot.vx=0;bot.vy=0;
      }
    }
    // Bot shoot at nearby player
    if(bot.st<=0){
      bot.st=7;
      for(let j=0;j<PL;j++){
        const p=PA[j];if(now<p.stealthEnd)continue;
        const d2=dst2(bot.x,bot.y,p.x,p.y);
        if(d2>1&&d2<200000){
          const d=Math.sqrt(d2),nx=(p.x-bot.x)/d,ny=(p.y-bot.y)/d;
          bullets.push({id:uid(),x:bot.x+nx*(br+5),y:bot.y+ny*(br+5),vx:nx*16,vy:ny*16,type:'shot',r:3,life:32,col:bot.col,owner:bot.id,dmg:5});
          bot.mass=Math.max(5,bot.mass-1);
        }
      }
    }
  }

  // Flush events
  for(const e of pending){e.to?io.to(e.to).emit(e.ev,e.d):io.emit(e.ev,e.d);}
  pending.length=0;
}

function broadcast(now){
  const PA=Object.values(players),PL=PA.length,BL=bots.length,aoi2=AOI_RANGE*AOI_RANGE;
  // Broadcast to spectators: full view of all bots and players
  for(const sid of spectators){
    const sock=io.sockets.sockets.get(sid);if(!sock)continue;
    const vP=PA.map(q=>({i:q.id,n:q.name,c:q.color,f:q.flag,x:Math.round(q.x),y:Math.round(q.y),m:Math.round(q.mass),
      sh:now<q.shieldEnd?1:0,st:0,inv:q.inv,cQ:0,cW:0,cR:0,cB:0,sE:0,mE:0,shE:q.shieldEnd,stE:0,bE:0}));
    const vB=bots.filter(b=>!b._deadUntil).map(b=>({i:b.id,x:Math.round(b.x),y:Math.round(b.y),m:Math.round(b.mass),c:b.col,n:b.name}));
    const vU=bullets.map(b=>({i:b.id,x:Math.round(b.x),y:Math.round(b.y),r:b.r,c:b.col,t:b.type==='bomb'?1:0,o:b.owner}));
    sock.emit('state',{t:now,p:vP,b:vB,u:vU});
  }
  for(let i=0;i<PL;i++){
    const p=PA[i],sock=io.sockets.sockets.get(p.id);if(!sock)continue;
    const vP=[],vB=[],vU=[];
    for(let j=0;j<PL;j++){
      const q=PA[j];
      if(j!==i&&dst2(p.x,p.y,q.x,q.y)>=aoi2)continue;
      if(j!==i&&now<q.stealthEnd)continue; // stealthed invisible to others
      vP.push({i:q.id,n:q.name,c:q.color,f:q.flag,x:Math.round(q.x),y:Math.round(q.y),m:Math.round(q.mass),
        sh:now<q.shieldEnd?1:0,st:now<q.stealthEnd?1:0,inv:q.inv,
        cQ:q.cdQ,cW:q.cdW,cR:q.cdR,cB:q.cdB,
        sE:q.speedEnd,mE:q.magnetEnd,shE:q.shieldEnd,stE:q.stealthEnd,bE:q.bulletEnd});
    }
    for(let j=0;j<BL;j++){
      const b=bots[j];if(b._deadUntil)continue;
      if(dst2(p.x,p.y,b.x,b.y)<aoi2)vB.push({i:b.id,x:Math.round(b.x),y:Math.round(b.y),m:Math.round(b.mass),c:b.col,n:b.name});
    }
    for(let j=0;j<bullets.length;j++){
      const b=bullets[j];if(dst2(p.x,p.y,b.x,b.y)<aoi2)vU.push({i:b.id,x:Math.round(b.x),y:Math.round(b.y),r:b.r,c:b.col,t:b.type==='bomb'?1:0,o:b.owner});
    }
    sock.emit('state',{t:now,p:vP,b:vB,u:vU});
  }
}

setTimeout(tick,TICK_MS);
setInterval(()=>io.emit('playerList',pList()),3000);
initWorld();
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('SpaceCell at http://localhost:'+PORT));
