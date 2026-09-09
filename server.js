'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT=__dirname,PORT=Number(process.env.PORT)||3000,DATA_FILE=path.join(ROOT,'players.json');

let players={};try{players=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))||{}}catch{players={}}
const rooms=new Map(),rounds=new Map();
const R=['6','7','8','9','10','J','Q','K','A'];
const SUITS=[['♠','black'],['♥','red'],['♦','red'],['♣','black']];
const V={6:6,7:7,8:8,9:9,10:10,J:2,Q:3,K:4,A:11};
const BOTS={fraer:{name:'Фраер',stake:1000,desc:'Рискованно берёт карты.'},shpilevoy:{name:'Шпилевой',stake:5000,desc:'Стабильная стратегия.'},shuler:{name:'Шулер',stake:10000,desc:'Максимально осторожная стратегия.'}};
const GIFTS=[0,1000,2000,3000,4000,5000,6000,10000];
const score=h=>h.reduce((a,c)=>a+(V[c.rank]||0),0);
const gold=h=>h.length===2&&h.every(c=>c.rank==='A');
const bust=h=>!gold(h)&&score(h)>21;
function persist(){fs.writeFileSync(DATA_FILE,JSON.stringify(players,null,2))}
function utcDate(){return new Date().toISOString().slice(0,10)}
function giftDay(p){const today=utcDate();if(!p.firstGiftDay){p.firstGiftDay=today;persist()}const a=Date.parse(p.firstGiftDay+'T00:00:00Z'),b=Date.parse(today+'T00:00:00Z');return Math.floor((b-a)/86400000)%7+1}
function giftInfo(p){const d=giftDay(p),today=utcDate();return{day:d,reward:GIFTS[d],claimed:p.lastGiftDate===today,nextReward:GIFTS[d===7?1:d+1],serverDate:today}}
function getPlayer(req,res){let sid=(req.headers.cookie||'').match(/(?:^|; )sid=([^;]+)/)?.[1];if(!sid||!players[sid]){sid=crypto.randomBytes(18).toString('hex');players[sid]={balance:1000,round:0,firstGiftDay:utcDate(),lastGiftDate:null,stats:{win:0,loss:0,push:0}};res.setHeader('Set-Cookie',`sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`);persist()}return[sid,players[sid]]}
function readBody(req){return new Promise(resolve=>{let s='';req.on('data',c=>{s+=c;if(s.length>50000)req.destroy()});req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch{resolve({})}})})}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
function makeDeck(){const d=[];for(const [s,c] of SUITS)for(const r of R)d.push({rank:r,suit:s,color:c});for(let i=d.length-1;i>0;i--){const j=crypto.randomInt(i+1);[d[i],d[j]]=[d[j],d[i]]}return d}
function draw(g){if(!g.deck.length)throw Error('Колода закончилась.');return g.deck.pop()}
function resultFor(player,dealer,stake){const pg=gold(player),dg=gold(dealer),pb=bust(player),db=bust(dealer);let type,title,delta=0;
 if(pb){type='loss';title='ПЕРЕБОР — ДИЛЕР ПОБЕДИЛ';delta=-stake}
 else if(db){type='win';title='ДИЛЕР ПЕРЕБРАЛ — ВЫ ПОБЕДИЛИ';delta=stake}
 else if(pg&&!dg){type='win';title='ЗОЛОТОЕ ОЧКО — ПОБЕДА';delta=stake}
 else if(dg&&!pg){type='loss';title='ЗОЛОТОЕ ОЧКО ДИЛЕРА';delta=-stake}
 else if(pg&&dg){type='push';title='ОБА: ЗОЛОТОЕ ОЧКО — НИЧЬЯ'}
 else if(score(player)>score(dealer)){type='win';title='ВЫ ПОБЕДИЛИ';delta=stake}
 else if(score(dealer)>score(player)){type='loss';title='ДИЛЕР ПОБЕДИЛ';delta=-stake}
 else{type='push';title='НИЧЬЯ — СТАВКА ВОЗВРАЩЕНА'}
 return{type,title,delta,payout:stake+Math.max(delta,0),playerScore:pg?'ЗОЛОТОЕ ОЧКО':score(player),dealerScore:dg?'ЗОЛОТОЕ ОЧКО':score(dealer)};
}
function settle(p,res){p.balance+=res.payout;if(res.type==='win')p.stats.win++;else if(res.type==='loss')p.stats.loss++;else p.stats.push++;persist()}
function dealerPlay(g){while(!gold(g.dealer)&&!bust(g.dealer)&&score(g.dealer)<17)g.dealer.push(draw(g))}
function publicBot(r){return{roundId:r.id,round:r.p.round,level:r.level,stake:r.stake,player:r.player,dealer:r.dealer,phase:r.phase,result:r.result,balance:r.p.balance}}
function startBot(p,level,free){const b=BOTS[level];if(!b)throw Error('Неизвестный бот.');const stake=free?0:b.stake;if(stake>p.balance)throw Error(`Недостаточно фишек. Для ${b.name} нужна ставка ${stake.toLocaleString('ru-RU')} 🪙.`);if(stake)p.balance-=stake;p.round++;const r={id:crypto.randomBytes(10).toString('hex'),p,level,stake,deck:makeDeck(),player:[],dealer:[],phase:'player',result:null,created:Date.now()};r.player.push(draw(r));r.dealer.push(draw(r));rounds.set(r.id,r);persist();return r}
function finishBot(r){if(r.phase==='finished')return;r.result=resultFor(r.player,r.dealer,r.stake);r.phase='finished';settle(r.p,r.result)}
function hitBot(r){r.player.push(draw(r));if(gold(r.player)||bust(r.player)||score(r.player)===21){if(bust(r.player))finishBot(r);else{dealerPlay(r);finishBot(r)}}}
function standBot(r){dealerPlay(r);finishBot(r)}
function roomView(room,sid){return{code:room.code,size:room.size,status:room.status,remaining:Math.max(0,15-Math.floor((Date.now()-room.created)/1000)),players:room.players.map(x=>({id:x.id===sid?'me':x.id,name:x.name,stake:x.stake,rematch:x.rematch,phase:x.phase})),turn:room.turn}}
function roomState(room,sid){const dealer=room.status==='finished'?room.dealer:room.dealer.map((c,i)=>i===0?{hidden:true}:c);return{dealer,players:room.players.map(x=>({id:x.id===sid?'me':x.id,name:x.name,hand:x.id===sid?x.hand:x.hand.map(()=>({hidden:true})),phase:x.phase,result:x.result,stake:x.stake})),turn:room.turn,status:room.status}}
function startRoom(room){if(room.status!=='waiting')return;room.status='playing';room.deck=makeDeck();room.dealer=[draw(room)];room.turn=0;for(const pl of room.players){pl.hand=[draw(room)];pl.phase='player';pl.result=null;pl.rematch=false}persist()}
function finishRoom(room){if(room.status!=='playing'||room.players.some(x=>x.phase==='player'))return;dealerPlay(room);for(const pl of room.players){pl.result=resultFor(pl.hand,room.dealer,pl.stake);pl.phase='finished';settle(pl.player,pl.result)}room.status='finished';persist()}
function actionRoom(room,sid,action){const i=room.players.findIndex(x=>x.id===sid);if(i<0)throw Error('Игрок не в комнате.');const pl=room.players[i];if(room.status!=='playing')throw Error('Партия ещё не началась.');if(room.turn!==i)throw Error('Сейчас ход другого игрока.');if(pl.phase!=='player')throw Error('Ваш ход уже завершён.');if(action==='hit'){pl.hand.push(draw(room));if(gold(pl.hand)||bust(pl.hand)||score(pl.hand)===21)pl.phase='finished'}else pl.phase='finished';while(room.turn<room.players.length&&room.players[room.turn].phase==='finished')room.turn++;finishRoom(room);persist()}
function cleanup(){const now=Date.now();for(const[k,r]of rounds)if(now-r.created>3600000)rounds.delete(k);for(const[k,r]of rooms)if(now-r.created>3600000){for(const pl of r.players){if(pl.staked){pl.player.balance+=pl.stake;pl.staked=false}}persist();rooms.delete(k)}}setInterval(cleanup,60000).unref();
const server=http.createServer(async(req,res)=>{
 const u=decodeURIComponent(req.url.split('?')[0]);const[sid,p]=getPlayer(req,res);
 if(u.startsWith('/api/')){
  try{
   if(req.method==='GET'&&u==='/api/me')return send(res,200,{balance:p.balance,round:p.round,stats:p.stats,gift:giftInfo(p)});
   if(req.method==='POST'&&u==='/api/daily-gift/claim'){const g=giftInfo(p);if(p.lastGiftDate===g.serverDate)return send(res,409,{error:'Подарок за сегодня уже получен.',balance:p.balance,gift:g});p.balance+=g.reward;p.lastGiftDate=g.serverDate;persist();return send(res,200,{balance:p.balance,gift:giftInfo(p)})}
   if(req.method==='POST'&&u==='/api/bot/start'){const q=await readBody(req),r=startBot(p,q.level,Boolean(q.free));return send(res,200,publicBot(r))}
   let m=u.match(/^\/api\/bot\/([a-f0-9]{20})\/(hit|stand)$/);if(m){const r=rounds.get(m[1]);if(!r||r.p!==p)return send(res,404,{error:'Раунд не найден.'});if(r.phase!=='player')return send(res,409,{error:'Раунд уже завершён.'});if(m[2]==='hit')hitBot(r);else standBot(r);return send(res,200,publicBot(r))}
   if(req.method==='POST'&&u==='/api/rooms'){
    const q=await readBody(req),size=[2,3,4].includes(Number(q.size))?Number(q.size):2,stake=Math.floor(Number(q.stake)||0);
    if(stake<1)return send(res,400,{error:'Введите ставку.'});if(stake>p.balance)return send(res,400,{error:'Ставка превышает баланс.'});
    let code=crypto.randomBytes(3).toString('hex').toUpperCase();while(rooms.has(code))code=crypto.randomBytes(3).toString('hex').toUpperCase();
    p.balance-=stake;persist();const room={code,size,created:Date.now(),status:'waiting',players:[{id:sid,name:'Игрок 1',player:p,stake,staked:true,hand:[],phase:'waiting',result:null,rematch:false}],deck:[],dealer:[],turn:0};rooms.set(code,room);return send(res,201,roomView(room,sid));
   }
   m=u.match(/^\/api\/rooms\/([A-Z0-9]{6})$/);if(m){
    const room=rooms.get(m[1]);if(!room)return send(res,404,{error:'Комната не найдена.'});
    if(room.status==='waiting'&&Date.now()-room.created>=15000)startRoom(room);
    if(req.method==='GET')return send(res,200,{...roomView(room,sid),roomState:room.status==='playing'||room.status==='finished'?roomState(room,sid):null});
    if(req.method==='POST'){
     const q=await readBody(req),action=q.action||'join';
     if(action==='join'){
      if(room.status!=='waiting')return send(res,409,{error:'Партия уже началась.'});
      if(room.players.some(x=>x.id===sid))return send(res,200,roomView(room,sid));
      if(room.players.length>=room.size)return send(res,409,{error:'Комната заполнена.'});
      const stake=Math.floor(Number(q.stake)||0);if(stake<1)return send(res,400,{error:'Введите ставку.'});if(stake>p.balance)return send(res,400,{error:'Ставка превышает баланс.'});
      p.balance-=stake;persist();room.players.push({id:sid,name:`Игрок ${room.players.length+1}`,player:p,stake,staked:true,hand:[],phase:'waiting',result:null,rematch:false});
      if(room.players.length===room.size)startRoom(room);return send(res,200,{...roomView(room,sid),roomState:room.status==='playing'?roomState(room,sid):null});
     }
     if(action==='rematch'){
      if(room.status!=='finished')return send(res,409,{error:'Реванш пока недоступен.'});const pl=room.players.find(x=>x.id===sid);if(!pl)return send(res,404,{error:'Игрок не в комнате.'});pl.rematch=true;
      if(room.players.every(x=>x.rematch)){
       for(const x of room.players)if(x.stake>x.player.balance)return send(res,409,{error:`${x.name} не хватает фишек для реванша.`});
       for(const x of room.players){x.player.balance-=x.stake;x.staked=true;x.hand=[];x.phase='player';x.result=null;x.rematch=false}
       room.status='playing';room.deck=makeDeck();room.dealer=[draw(room)];room.turn=0;for(const x of room.players)x.hand=[draw(room)];persist();
      }
      return send(res,200,{...roomView(room,sid),roomState:room.status==='playing'?roomState(room,sid):null});
     }
     if(action==='hit'||action==='stand'){try{actionRoom(room,sid,action);return send(res,200,{...roomView(room,sid),roomState:roomState(room,sid)})}catch(e){return send(res,409,{error:e.message})}}
    }
    return send(res,400,{error:'Неизвестное действие.'});
   }
   return send(res,404,{error:'API not found'});
  }catch(e){return send(res,500,{error:e.message||'Server error'})}
 }
 let file=u==='/'?'/index.html':u;if(file==='/favicon.ico')file='/favicon.svg';const full=path.normalize(path.join(ROOT,file));if(!full.startsWith(ROOT))return res.writeHead(403).end('Forbidden');
 fs.readFile(full,(e,d)=>{if(e){res.writeHead(404);return res.end('404')}const ext=path.extname(full),ct={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml'}[ext]||'application/octet-stream';res.writeHead(200,{'Content-Type':ct,'Cache-Control':'no-store'});res.end(d)});
});
server.listen(PORT,()=>console.log(`SANI GROUP 21 server on ${PORT}`));
