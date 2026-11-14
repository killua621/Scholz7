const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const rooms = new Map();
const indexFile = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, {'content-type':'text/plain'}); return res.end('ok'); }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, {'content-type':'text/html; charset=utf-8', 'cache-control':'no-cache'});
    return fs.createReadStream(indexFile).pipe(res);
  }
  res.writeHead(404, {'content-type':'text/plain'}); res.end('Not found');
});

const wss = new WebSocketServer({ server, maxPayload: 2048 });
function makeCode(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let code;do{code=Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join('')}while(rooms.has(code));return code;}
function makeDeck(){const d=[{type:'number',value:0}];for(let n=1;n<=12;n++)for(let i=0;i<n;i++)d.push({type:'number',value:n});for(const name of ['Freeze','Flip Three','Second Chance'])for(let i=0;i<3;i++)d.push({type:'action',value:name});for(const value of ['+2','+4','+6','+8','+10','×2'])d.push({type:'modifier',value});for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]]}return d;}
function hasSecond(p){return p.cards.some(c=>c.type==='action'&&c.value==='Second Chance');}
function score(p){if(p.busted)return 0;const numbers=p.cards.filter(c=>c.type==='number'&&!c.duplicate);let n=numbers.reduce((a,c)=>a+c.value,0);if(p.cards.some(c=>c.type==='modifier'&&c.value==='×2'))n*=2;n+=p.cards.filter(c=>c.type==='modifier'&&c.value!== '×2').reduce((a,c)=>a+Number(c.value.slice(1)),0);if(new Set(numbers.map(c=>c.value)).size>=7)n+=15;return n;}
function roundStart(room){room.round++;room.deck=makeDeck();room.started=room.players.filter(p=>p.online).length>=2;room.gameOver=false;room.winnerName='';room.turn=null;room.forced=null;room.pendingChoice=null;room.deferredActions=[];room.processingDeferred=false;room.processingOrigin=null;for(const p of room.players){p.cards=[];p.roundScore=0;p.busted=false;p.frozen=false;p.active=room.started&&p.online;p.waiting=!room.started&&p.online;}if(room.started){room.turn=room.players.find(p=>p.online)?.id||null;}room.lastMessage=room.started?'Nova rodada. Boa sorte na mesa!':'Aguardando mais jogadores.';}
function snapshot(room){const turn=room.players.find(p=>p.id===room.turn);return {code:room.code,hostId:room.hostId,round:room.round,started:room.started,gameOver:room.gameOver,winnerName:room.winnerName,turn:room.turn,turnName:turn?.name||'',deckCount:room.deck.length,lastMessage:room.lastMessage,forced:room.forced?{targetId:room.forced.targetId,remaining:room.forced.remaining}:null,pendingChoice:room.pendingChoice?{fromId:room.pendingChoice.fromId,card:room.pendingChoice.card,eligible:room.pendingChoice.eligible}:null,players:room.players.map(p=>({id:p.id,name:p.name,score:p.score,roundScore:score(p),cards:p.cards,active:p.active,busted:p.busted,frozen:p.frozen,waiting:p.waiting,online:p.online}))};}
function broadcast(room){const message=JSON.stringify({type:'state',state:snapshot(room)});for(const p of room.players)if(p.ws?.readyState===1)p.ws.send(message);}
function tell(ws,type,message){if(ws.readyState===1)ws.send(JSON.stringify({type,message}));}
function nextTurn(room,from){const active=room.players.filter(p=>p.active);if(!active.length){finishRound(room);return}const start=room.players.findIndex(p=>p.id===from);for(let i=1;i<=room.players.length;i++){const p=room.players[(start+i+room.players.length)%room.players.length];if(p?.active){room.turn=p.id;return}}}
function finishRound(room){for(const p of room.players)p.score+=score(p);const best=Math.max(0,...room.players.map(p=>p.score));if(best>=200){room.gameOver=true;room.started=false;room.winnerName=room.players.filter(p=>p.score===best).map(p=>p.name).join(' & ');room.turn=null;room.lastMessage=room.winnerName+' venceu a partida!';room.forced=null;room.pendingChoice=null;return}room.lastMessage='Pontos contabilizados. Próxima rodada!';roundStart(room);}
function activeEligible(room,excludeSecond=false){return room.players.filter(p=>p.active&&(!excludeSecond||!hasSecond(p))).map(p=>p.id);}
function askTarget(room,fromId,card,eligible){if(!eligible.length){room.lastMessage='Não havia jogador disponível para receber '+card+'.';return false}room.pendingChoice={fromId,card,eligible};room.turn=fromId;room.lastMessage=room.players.find(p=>p.id===fromId)?.name+' escolhe quem recebe '+card+'.';return true;}
function startFlipThree(room,target){room.forced={targetId:target.id,originId:target.id,remaining:3};room.turn=target.id;room.lastMessage=target.name+' recebeu Flip Três: revele até 3 cartas.';}
function completeForced(room){const origin=room.forced?.originId||room.processingOrigin;room.forced=null;room.processingDeferred=true;room.processingOrigin=origin;if(room.deferredActions.length){const next=room.deferredActions.shift();const eligible=activeEligible(room,next==='Second Chance');if(askTarget(room,origin,next,eligible))return;completeForced(room);return}room.processingDeferred=false;room.processingOrigin=null;if(origin)nextTurn(room,origin)}
function applyChosen(room,choice,target){const source=room.players.find(p=>p.id===choice.fromId);const card=choice.card;room.pendingChoice=null;if(card==='Second Chance'){target.cards.push({type:'action',value:'Second Chance'});room.lastMessage=target.name+' recebeu Segunda Chance.';if(room.processingDeferred)completeForced(room);else nextTurn(room,source?.id||target.id);return}if(card==='Freeze'){target.cards.push({type:'action',value:'Freeze'});target.active=false;target.frozen=true;room.lastMessage=target.name+' congelou e garantiu '+score(target)+' pontos.';if(room.processingDeferred)completeForced(room);else nextTurn(room,source?.id||target.id);return}if(card==='Flip Three'){target.cards.push({type:'action',value:'Flip Three'});startFlipThree(room,target);return}}
function finishDraw(room,p,card){const forced=room.forced&&room.forced.targetId===p.id;let busted=false,seven=false;room.deck.pop();if(!card){room.lastMessage='O baralho acabou.';finishRound(room);return}
  if(card.type==='number'&&p.cards.some(c=>c.type==='number'&&!c.duplicate&&c.value===card.value)){
    if(hasSecond(p)){const idx=p.cards.findIndex(c=>c.type==='action'&&c.value==='Second Chance');p.cards.splice(idx,1);room.lastMessage=p.name+' usou Segunda Chance para escapar do '+card.value+'.';}
    else{p.cards.push({...card,duplicate:true});p.busted=true;p.active=false;busted=true;room.lastMessage=p.name+' repetiu '+card.value+' e estourou.';}
  }else if(card.type==='action'){
    if(forced&&card.value!=='Second Chance'){room.deferredActions.push(card.value);room.lastMessage=p.name+' revelou '+card.value+'. Ação depois das 3 cartas.';}
    else if(card.value==='Second Chance'){
      if(!hasSecond(p)){p.cards.push(card);room.lastMessage=p.name+' ganhou uma Segunda Chance.';}
      else{const eligible=activeEligible(room,true).filter(id=>id!==p.id);if(forced){const recipient=room.players.find(x=>eligible.includes(x.id));if(recipient){recipient.cards.push(card);room.lastMessage=recipient.name+' recebeu Segunda Chance.'}else room.lastMessage='Segunda Chance descartada: ninguém podia recebê-la.';}
        else{const choices=eligible.length?eligible:activeEligible(room,true);if(askTarget(room,p.id,'Second Chance',choices))return;room.lastMessage='Segunda Chance descartada: ninguém podia recebê-la.';}}
    }else if(forced){room.deferredActions.push(card.value);room.lastMessage=p.name+' revelou '+card.value+'. Ação depois das 3 cartas.';}
    else{const eligible=activeEligible(room);if(askTarget(room,p.id,card.value,eligible))return;room.lastMessage=card.value+' descartada: sem alvos ativos.';}
  }else{p.cards.push(card);room.lastMessage=p.name+' revelou '+card.value+'.'}
  p.roundScore=score(p);
  if(p.active&&p.cards.filter(c=>c.type==='number'&&!c.duplicate).length>=7&&new Set(p.cards.filter(c=>c.type==='number'&&!c.duplicate).map(c=>c.value)).size>=7){p.roundScore=score(p);p.active=false;seven=true;room.lastMessage=p.name+' completou Scholz 7! +15 pontos.';for(const x of room.players)x.score+=score(x);const best=Math.max(0,...room.players.map(x=>x.score));if(best>=200){room.gameOver=true;room.started=false;room.winnerName=room.players.filter(x=>x.score===best).map(x=>x.name).join(' & ');room.turn=null;room.forced=null;room.pendingChoice=null;return}room.round--;room.lastMessage+=' Rodada encerrada para todos.';roundStart(room);return}
  if(forced){room.forced.remaining--;if(busted){room.forced.remaining=0;room.deferredActions=[]}if(room.forced.remaining<=0){completeForced(room)}else{room.turn=p.id}}
  else if(p.active){nextTurn(room,p.id)}else{nextTurn(room,p.id)}
}
function handleChoice(room,p,targetId){const choice=room.pendingChoice;if(!choice||choice.fromId!==p.id||!choice.eligible.includes(targetId))return;const target=room.players.find(x=>x.id===targetId&&x.active);if(!target)return;applyChosen(room,choice,target);}
function newRoom(){return {code:makeCode(),hostId:null,players:[],round:0,deck:[],turn:null,started:false,gameOver:false,winnerName:'',lastMessage:'Aguardando jogadores.',forced:null,pendingChoice:null,deferredActions:[],processingDeferred:false,processingOrigin:null};}
function makeCode(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let code;do{code=Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join('')}while(rooms.has(code));return code;}
wss.on('connection',ws=>{ws.isAlive=true;ws.on('pong',()=>ws.isAlive=true);ws.on('message',raw=>{let msg;try{msg=JSON.parse(raw.toString())}catch{return tell(ws,'error','Mensagem inválida.')}if(msg.type==='join'){if(ws.room)return;const name=String(msg.name||'').trim().replace(/[<>]/g,'').slice(0,18);if(!name)return tell(ws,'error','Digite um nome para entrar.');let code=String(msg.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);let room;if(code){room=rooms.get(code);if(!room)return tell(ws,'error','Não encontramos essa sala. Confira o código do convite.')}else{room=newRoom();rooms.set(room.code,room);code=room.code}if(room.players.some(p=>p.online&&p.name.toLowerCase()===name.toLowerCase()))return tell(ws,'error','Esse nome já está sendo usado nesta sala. Escolha outro.');if(room.players.filter(p=>p.online).length>=8)return tell(ws,'error','Esta mesa já está cheia (8 jogadores).');const id=Math.random().toString(36).slice(2,10);const player={id,name,score:0,roundScore:0,cards:[],active:false,busted:false,frozen:false,waiting:true,online:true,ws};if(!room.hostId)room.hostId=id;room.players.push(player);ws.room=code;ws.playerId=id;if(room.players.filter(p=>p.online).length>=2&&!room.started&&!room.gameOver)roundStart(room);ws.send(JSON.stringify({type:'joined',playerId:id,code,state:snapshot(room)}));broadcast(room);return}
  const room=rooms.get(ws.room),p=room?.players.find(x=>x.id===ws.playerId);if(!room||!p)return;if(msg.type==='draw'&&room.started&&!room.gameOver&&!room.pendingChoice&&room.turn===p.id){const card=room.deck[room.deck.length-1];finishDraw(room,p,card)}else if(msg.type==='stop'&&room.started&&!room.gameOver&&!room.pendingChoice&&room.turn===p.id&&p.active){if(room.forced){tell(ws,'notice','Com Flip Três você precisa revelar as cartas restantes.');return}p.active=false;room.lastMessage=p.name+' parou e guardou '+score(p)+' pontos.';nextTurn(room,p.id)}else if(msg.type==='choose'){handleChoice(room,p,String(msg.targetId||''))}else if(msg.type==='newGame'&&room.gameOver&&p.id===room.hostId){for(const x of room.players)x.score=0;room.round=0;room.gameOver=false;room.winnerName='';roundStart(room)}broadcast(room)});
  ws.on('close',()=>{const room=rooms.get(ws.room);if(!room)return;const p=room.players.find(x=>x.id===ws.playerId);if(!p)return;p.online=false;p.active=false;room.players=room.players.filter(x=>x.online);if(!room.players.length){rooms.delete(room.code);return}if(room.hostId===p.id)room.hostId=room.players[0].id;if(room.pendingChoice?.fromId===p.id)room.pendingChoice=null;if(room.forced?.targetId===p.id){room.forced.remaining=0;completeForced(room)}if(room.turn===p.id&&!room.pendingChoice&&!room.forced)nextTurn(room,p.id);if(room.started&&!room.players.some(x=>x.active))finishRound(room);broadcast(room)});
});
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue}ws.isAlive=false;ws.ping()}},25000);wss.on('close',()=>clearInterval(heartbeat));
server.listen(PORT,'0.0.0.0',()=>console.log('Scholz 7 listening on '+PORT));



