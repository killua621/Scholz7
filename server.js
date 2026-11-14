const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const rooms = new Map();
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, {'content-type':'text/plain'}); return res.end('ok'); }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, {'content-type':'text/html; charset=utf-8', 'cache-control':'no-cache'});
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  res.writeHead(404, {'content-type':'text/plain'}); res.end('Not found');
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

function id(){return Math.random().toString(36).slice(2,10)}
function makeCode(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let c;do{c=Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join('')}while(rooms.has(c));return c}
function card(type,value,special){return {id:id(),type,value,special:special||''}}
function makeDeck(){
  const d=[];
  for(let n=1;n<=13;n++){let count=n;if(n===7)count=6;if(n===13)count=12;for(let i=0;i<count;i++)d.push(card('number',n))}
  d.push(card('number',0,'The Zero'),card('number',7,'Unlucky 7'),card('number',13,'Lucky 13'));
  for(const value of ['-2','-4','-6','-8','-10','÷2'])d.push(card('modifier',value));
  for(const value of ['Just One More','Flip Four','Swap','Steal','Discard'])for(let i=0;i<2;i++)d.push(card('action',value));
  for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]]}return d;
}
function numbers(p){return p.cards.filter(c=>c.type==='number')}
function busts(p){if(p.busted)return true;const vals={};for(const c of numbers(p))vals[c.value]=(vals[c.value]||0)+1;return Object.values(vals).some(n=>n>1)}
function score(p){if(p.busted)return 0;const nums=numbers(p);if(nums.some(c=>c.special==='The Zero')&&nums.length<7)return 0;let n=nums.reduce((a,c)=>a+c.value,0);if(p.cards.some(c=>c.type==='modifier'&&c.value==='÷2'))n=Math.floor(n/2);n-=p.cards.filter(c=>c.type==='modifier'&&c.value!=='÷2').reduce((a,c)=>a+Math.abs(Number(c.value)),0);if(n<0)n=0;if(nums.length>=7)n+=15;return n}
function canHit(p){return p.active&&!p.busted}
function targetable(room){return room.players.filter(p=>!p.busted&&p.online)}
function newRoom(){return {code:makeCode(),hostId:null,players:[],round:0,deck:[],discard:[],turn:null,started:false,gameOver:false,winnerName:'',lastMessage:'Aguardando jogadores.',forced:null,forcedStack:[],pendingChoice:null,resolving:null}}
function roundStart(room){room.bustEvent=null;room.round++;room.deck=makeDeck();room.discard=[];room.started=room.players.filter(p=>p.online).length>=2;room.gameOver=false;room.winnerName='';room.turn=null;room.forced=null;room.forcedStack=[];room.pendingChoice=null;room.resolving=null;for(const p of room.players){p.cards=[];p.active=room.started&&p.online;p.stayed=false;p.busted=false;p.waiting=!room.started&&p.online}if(room.started)room.turn=room.players.find(p=>p.online)?.id||null;room.lastMessage=room.started?'Nova rodada. Ninguém está a salvo.':'Aguardando mais jogadores.'}
function snapshot(room){const turn=room.players.find(p=>p.id===room.turn);return {code:room.code,hostId:room.hostId,round:room.round,started:room.started,gameOver:room.gameOver,winnerName:room.winnerName,turn:room.turn,turnName:turn?.name||'',deckCount:room.deck.length,lastMessage:room.lastMessage,bustEvent:room.bustEvent||null,forced:room.forced?{targetId:room.forced.targetId,targetName:room.players.find(p=>p.id===room.forced.targetId)?.name||'',originId:room.forced.originId,originName:room.players.find(p=>p.id===room.forced.originId)?.name||'',remaining:room.forced.remaining,type:room.forced.type}:null,pendingChoice:room.pendingChoice?{fromId:room.pendingChoice.fromId,card:room.pendingChoice.card,step:room.pendingChoice.step,choices:room.pendingChoice.choices}:null,players:room.players.map(p=>({id:p.id,name:p.name,score:p.score,roundScore:score(p),cards:p.cards,active:p.active,stayed:p.stayed,busted:p.busted,waiting:p.waiting,online:p.online,mustHit:p.cards.some(c=>c.type==='number'&&c.special==='The Zero'&&numbers(p).length<7)}))}}
function broadcast(room){const m=JSON.stringify({type:'state',state:snapshot(room)});for(const p of room.players)if(p.ws?.readyState===1)p.ws.send(m)}
function tell(ws,type,message){if(ws.readyState===1)ws.send(JSON.stringify({type,message}))}
function nextTurn(room,from){if(room.gameOver)return;const active=room.players.filter(p=>p.active&&!p.busted);if(!active.length){finishRound(room);return}const start=room.players.findIndex(p=>p.id===from);for(let i=1;i<=room.players.length;i++){const p=room.players[(start+i+room.players.length)%room.players.length];if(p?.active&&!p.busted){room.turn=p.id;return}}}
function finishRound(room){for(const p of room.players)p.score+=score(p);const high=Math.max(0,...room.players.map(p=>p.score));if(high>=200){room.gameOver=true;room.started=false;room.winnerName=room.players.filter(p=>p.score===high).map(p=>p.name).join(' & ');room.turn=null;room.lastMessage=room.winnerName+' venceu a partida!';return}room.lastMessage='Pontos contabilizados. Próxima rodada!';roundStart(room)}
function duplicate(p,value,incoming){return numbers(p).some(x=>x.value===value)}
function markBust(p){if(busts(p)){p.busted=true;p.active=false;p.stayed=false;return true}return false}
function receiveCard(room,p,c){if(c.special==='Unlucky 7'){const old=p.cards.filter(x=>x.type==='number'||x.type==='modifier');room.discard.push(...old);p.cards=p.cards.filter(x=>x.type!=='number'&&x.type!=='modifier');p.cards.push(c);room.lastMessage=p.name+' recebeu o 7 da Má Sorte: a linha foi limpa.';return}p.cards.push(c)}
function applyNumber(room,p,c){if(c.special==='Unlucky 7'){const old=p.cards.filter(x=>x.type==='number'||x.type==='modifier');room.discard.push(...old);p.cards=p.cards.filter(x=>x.type==='action');p.cards.push(c);room.lastMessage=p.name+' recebeu o 7 da Má Sorte: a linha foi limpa.';return false}if(c.type==='number'&&duplicate(p,c.value,c)){p.cards.push(c);p.busted=true;p.active=false;p.stayed=false;room.lastMessage='RECUA FASCISTA, VOCÊ ESTOUROU!';room.bustEvent={playerId:p.id,name:p.name,value:c.value};return true}p.cards.push(c);room.lastMessage=p.name+' revelou '+(c.special||c.value)+'.';if(c.special==='The Zero')room.lastMessage=p.name+' revelou Zero: precisa continuar comprando.';return false}
function flip7(p){return numbers(p).length>=7}
function makeOptions(players,fn){return players.map(fn)}
function askChoice(room,from,cardName,step,choices,data){if(!choices.length)return false;room.pendingChoice={fromId:from.id,card:cardName,step,choices:choices.map((x,i)=>({id:String(i),label:x.label,data:x.data})),data:data||null};room.turn=from.id;room.lastMessage=from.name+' resolve '+cardName+'.';return true}
function drawRefs(room,exclude,excludePlayer){const a=[];for(const p of targetable(room))if(p.id!==excludePlayer)for(const c of p.cards)if(c.type!=='action'&&c.id!==exclude)a.push({label:p.name+' · '+cardLabel(c),data:{playerId:p.id,cardId:c.id}});return a}
function targetChoices(room,actor,allowSelf=true){return targetable(room).filter(p=>allowSelf||p.id!==actor.id).map(p=>({label:p.name+(p.id===actor.id?' (você)':''),data:{targetId:p.id}}))}
function cardLabel(c){return c.special||String(c.value)}
function beginEffect(room,actor,c,sourceForced){if(c.type==='modifier'){const opts=targetChoices(room,actor);if(askChoice(room,actor,c.value,'target',opts,{card:c,kind:'modifier',sourceForced:!!sourceForced}))return true;room.discard.push(c);afterEffect(room,actor,sourceForced);return false}
  if(c.value==='Just One More'||c.value==='Flip Four'){const opts=targetChoices(room,actor);if(askChoice(room,actor,c.value,'target',opts,{card:c,kind:'force',sourceForced:!!sourceForced}))return true;room.discard.push(c);afterEffect(room,actor,sourceForced);return false}
  if(c.value==='Swap'){const opts=drawRefs(room);if(askChoice(room,actor,c.value,'swap-first',opts,{card:c,kind:'swap',sourceForced:!!sourceForced}))return true;room.discard.push(c);afterEffect(room,actor,sourceForced);return false}
  if(c.value==='Steal'){const opts=drawRefs(room,null,actor.id);if(askChoice(room,actor,c.value,'steal-card',opts,{card:c,kind:'steal',sourceForced:!!sourceForced}))return true;room.discard.push(c);afterEffect(room,actor,sourceForced);return false}
  if(c.value==='Discard'){const opts=targetChoices(room,actor);if(askChoice(room,actor,c.value,'discard-target',opts,{card:c,kind:'discard',sourceForced:!!sourceForced}))return true;room.discard.push(c);afterEffect(room,actor,sourceForced);return false}
  room.discard.push(c);afterEffect(room,actor,sourceForced);return false;
}
function startForced(room,actor,target,type,sourceId,sourceWasActive){room.bustEvent=null;if(room.forced)room.forcedStack.push(room.forced);room.forced={targetId:target.id,remaining:type==='one'?1:4,type,originId:sourceId,sourceWasActive,awaiting:false,deferred:[]};room.turn=target.id;room.lastMessage=target.name+' recebeu '+(type==='one'?'Just One More':'Flip Four')+'.'}
function finishForced(room){const f=room.forced;if(!f)return;room.forced=null;const target=room.players.find(p=>p.id===f.targetId);if(f.type==='one'&&target&&!target.busted){target.active=false;target.stayed=true}if(f.deferred?.length&&!target?.busted){room.resolving={originId:f.originId,targetId:f.targetId,items:f.deferred,index:0};processDeferred(room);return}if(room.forcedStack.length){room.forced=room.forcedStack.pop();advanceParentForced(room);return}if(room.resolving){processDeferred(room);return}nextTurn(room,f.originId)}
function advanceParentForced(room){const f=room.forced;if(!f)return;if(f.remaining<=0){finishForced(room);return}room.turn=f.targetId}
function finishNumberRound(room,p){for(const x of room.players)x.score+=score(x);const high=Math.max(0,...room.players.map(x=>x.score));if(high>=200){room.gameOver=true;room.started=false;room.winnerName=room.players.filter(x=>x.score===high).map(x=>x.name).join(' & ');room.turn=null;room.lastMessage=p.name+' completou Scholz 7. '+room.winnerName+' venceu!';return}room.lastMessage=p.name+' completou Scholz 7! +15 pontos para a rodada.';roundStart(room)}
function completeForcedDraw(room,p,cardObj){const f=room.forced;if(!f)return;f.remaining--;if(p.busted){f.remaining=0;f.deferred=[];finishForced(room);return}if(f.type==='four'&&f.remaining>0){room.turn=p.id;return}if(f.type==='four'&&f.remaining===0){finishForced(room);return}if(f.type==='one')finishForced(room)}
function afterEffect(room,actor,sourceForced){if(room.resolving){processDeferred(room);return}if(room.forced?.awaiting){room.forced.awaiting=false;finishForced(room);return}if(sourceForced&&room.forced){completeForcedDraw(room,actor,null);return}nextTurn(room,actor.id)}
function processDeferred(room){const r=room.resolving;if(!r)return;if(r.index>=r.items.length){room.resolving=null;if(room.forcedStack.length){room.forced=room.forcedStack.pop();advanceParentForced(room);return}nextTurn(room,r.originId);return}const item=r.items[r.index++],actor=room.players.find(p=>p.id===r.targetId);if(!actor||actor.busted){room.resolving=null;nextTurn(room,r.originId);return}beginEffect(room,actor,item,true)}
function resolveChoice(room,actor,choiceId){const q=room.pendingChoice;if(!q||q.fromId!==actor.id)return;const o=q.choices.find(x=>x.id===choiceId);if(!o)return;const d=q.data||{};const cardObj=d.card;room.pendingChoice=null;
  if(q.step==='target'&&d.kind==='modifier'){const t=room.players.find(p=>p.id===o.data.targetId);if(t){t.cards.push(cardObj);room.lastMessage=actor.name+' aplicou '+cardObj.value+' em '+t.name+'.';}else room.discard.push(cardObj);afterEffect(room,actor,d.sourceForced);return}
  if(q.step==='target'&&d.kind==='force'){const t=room.players.find(p=>p.id===o.data.targetId);if(!t){room.discard.push(cardObj);afterEffect(room,actor,d.sourceForced);return}room.discard.push(cardObj);startForced(room,actor,t,cardObj.value==='Just One More'?'one':'four',actor.id,t.active);if(d.sourceForced&&room.forcedStack.length===0){/* forced effect waits for the nested draw */}return}
  if(q.step==='swap-first'){const ref=o.data;const opts=drawRefs(room,ref.cardId);if(askChoice(room,actor,'Swap','swap-second',opts,{card:cardObj,kind:'swap',sourceForced:d.sourceForced,first:ref}))return;room.discard.push(cardObj);afterEffect(room,actor,d.sourceForced);return}
  if(q.step==='swap-second'){const a=d.first,b=o.data,pa=room.players.find(p=>p.id===a.playerId),pb=room.players.find(p=>p.id===b.playerId),ia=pa?.cards.findIndex(c=>c.id===a.cardId),ib=pb?.cards.findIndex(c=>c.id===b.cardId);if(pa&&pb&&ia>=0&&ib>=0){const temp=pa.cards[ia];pa.cards[ia]=pb.cards[ib];pb.cards[ib]=temp;if(pa.cards[ia].special==='Unlucky 7')receiveCard(room,pa,pa.cards[ia]);if(pb.cards[ib].special==='Unlucky 7')receiveCard(room,pb,pb.cards[ib]);markBust(pa);markBust(pb);room.lastMessage=actor.name+' trocou duas cartas.';}room.discard.push(cardObj);afterEffect(room,actor,d.sourceForced);return}
  if(q.step==='steal-card'){const ref=o.data,from=room.players.find(p=>p.id===ref.playerId),to=actor,idx=from?.cards.findIndex(c=>c.id===ref.cardId);if(from&&idx>=0){const [stolen]=from.cards.splice(idx,1);receiveCard(room,to,stolen);markBust(to);markBust(from);room.lastMessage=actor.name+' roubou '+cardLabel(stolen)+' de '+from.name+'.';}room.discard.push(cardObj);afterEffect(room,actor,d.sourceForced);return}
  if(q.step==='discard-target'){const target=room.players.find(p=>p.id===o.data.targetId);if(!target){room.discard.push(cardObj);afterEffect(room,actor,d.sourceForced);return}const opts=target.cards.map(c=>({label:target.name+' · '+cardLabel(c),data:{targetId:target.id,cardId:c.id}}));if(askChoice(room,actor,'Discard','discard-card',opts,{card:cardObj,kind:'discard',sourceForced:d.sourceForced,targetId:target.id}))return;room.discard.push(cardObj);afterEffect(room,actor,d.sourceForced);return}
  if(q.step==='discard-card'){const target=room.players.find(p=>p.id===o.data.targetId),idx=target?.cards.findIndex(c=>c.id===o.data.cardId);if(target&&idx>=0){const [removed]=target.cards.splice(idx,1);room.discard.push(removed);room.lastMessage=actor.name+' descartou '+cardLabel(removed)+' de '+target.name+'.';markBust(target)}room.discard.push(cardObj);afterEffect(room,actor,d.sourceForced);return}
}
function drawCard(room,p){const f=room.forced;const isForced=!!f&&f.targetId===p.id;if(f&&!isForced)return;if(!room.deck.length){finishRound(room);return}const c=room.deck.pop();const fromForcedFour=isForced&&f.type==='four';const fromForcedOne=isForced&&f.type==='one';if(isForced&&fromForcedOne){f.awaiting=true;f.remaining=0;}
  if(fromForcedFour&&(c.type==='action'||c.type==='modifier')){f.deferred.push(c);completeForcedDraw(room,p,c);return}
  if(c.type==='number'){const busted=applyNumber(room,p,c);markBust(p);if(!busted&&flip7(p)){finishNumberRound(room,p);return}if(isForced)completeForcedDraw(room,p,c);else nextTurn(room,p.id);return}
  if(c.type==='modifier'||c.type==='action'){beginEffect(room,p,c,isForced);if(isForced&&f.type==='four'){/* effect is queued after the four only for this mode */}return}
}
function handle(room,p,msg){if(msg.type==='draw'&&room.started&&!room.gameOver&&!room.pendingChoice&&room.turn===p.id&&((room.forced&&room.forced.targetId===p.id)||p.active))drawCard(room,p);
  else if(msg.type==='stop'&&room.started&&!room.gameOver&&!room.pendingChoice&&!room.forced&&room.turn===p.id&&p.active){if(p.cards.some(c=>c.special==='The Zero')&&numbers(p).length<7){tell(p.ws,'notice','Com o Zero na mesa, você precisa continuar.');return}p.active=false;p.stayed=true;room.lastMessage=p.name+' ficou. Ainda pode ser alvo nesta rodada.';nextTurn(room,p.id)}
  else if(msg.type==='choose')resolveChoice(room,p,String(msg.choiceId||''));
  else if(msg.type==='newGame'&&room.gameOver&&p.id===room.hostId){for(const x of room.players)x.score=0;room.round=0;room.gameOver=false;room.winnerName='';roundStart(room)}
}
function newCodeRoom(){return newRoom()}
wss.on('connection',ws=>{ws.isAlive=true;ws.on('pong',()=>ws.isAlive=true);ws.on('message',raw=>{let msg;try{msg=JSON.parse(raw.toString())}catch{return tell(ws,'error','Mensagem inválida.')}if(msg.type==='join'){if(ws.room)return;const name=String(msg.name||'').trim().replace(/[<>]/g,'').slice(0,18);if(!name)return tell(ws,'error','Digite um nome para entrar.');let code=String(msg.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6),room;if(code){room=rooms.get(code);if(!room)return tell(ws,'error','Não encontramos essa sala. Confira o código do convite.')}else{room=newCodeRoom();rooms.set(room.code,room);code=room.code}if(room.players.some(p=>p.online&&p.name.toLowerCase()===name.toLowerCase()))return tell(ws,'error','Esse nome já está sendo usado nesta sala. Escolha outro.');if(room.players.filter(p=>p.online).length>=8)return tell(ws,'error','Esta mesa já está cheia (8 jogadores).');const player={id:id(),name,score:0,cards:[],active:false,stayed:false,busted:false,waiting:true,online:true,ws};if(!room.hostId)room.hostId=player.id;room.players.push(player);ws.room=code;ws.playerId=player.id;if(room.players.filter(p=>p.online).length>=2&&!room.started&&!room.gameOver)roundStart(room);ws.send(JSON.stringify({type:'joined',playerId:player.id,code,state:snapshot(room)}));broadcast(room);return}
  const room=rooms.get(ws.room),p=room?.players.find(x=>x.id===ws.playerId);if(!room||!p)return;handle(room,p,msg);broadcast(room)});
  ws.on('close',()=>{const room=rooms.get(ws.room);if(!room)return;const p=room.players.find(x=>x.id===ws.playerId);if(!p)return;p.online=false;p.active=false;room.players=room.players.filter(x=>x.online);if(!room.players.length){rooms.delete(room.code);return}if(room.hostId===p.id)room.hostId=room.players[0].id;if(room.pendingChoice?.fromId===p.id)room.pendingChoice=null;if(room.turn===p.id&&!room.pendingChoice)nextTurn(room,p.id);if(room.started&&!room.players.some(x=>x.active&&!x.busted))finishRound(room);broadcast(room)});
});
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue}ws.isAlive=false;ws.ping()}},25000);wss.on('close',()=>clearInterval(heartbeat));
server.listen(PORT,'0.0.0.0',()=>console.log('Scholz 7 Vingança listening on '+PORT));




