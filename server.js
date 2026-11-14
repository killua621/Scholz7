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
function makeDeck(){const d=[0];for(let n=1;n<=12;n++)for(let i=0;i<n;i++)d.push(n);for(let i=0;i<3;i++)d.push('+5');for(let i=0;i<3;i++)d.push('×2');for(let i=d.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]]}return d;}
function roundStart(room){room.round++;room.deck=makeDeck();room.started=room.players.filter(p=>p.online).length>=2;room.turn=null;for(const p of room.players){p.cards=[];p.roundScore=0;p.busted=false;p.active=room.started&&p.online;p.waiting=!room.started&&p.online;}if(room.started){const first=room.players.find(p=>p.online);room.turn=first?.id||null;}room.lastMessage=room.started?'Nova rodada. Que comecem as apostas!':'Aguardando mais jogadores.';}
function snapshot(room){const turn=room.players.find(p=>p.id===room.turn);return {code:room.code,hostId:room.hostId,round:room.round,started:room.started,gameOver:room.gameOver,winnerName:room.winnerName,turn:room.turn,turnName:turn?.name||'',deckCount:room.deck.length,lastMessage:room.lastMessage,players:room.players.map(p=>({id:p.id,name:p.name,score:p.score,roundScore:p.roundScore,cards:p.cards,active:p.active,busted:p.busted,waiting:p.waiting,online:p.online}))};}
function broadcast(room,type='state'){const message=JSON.stringify({type,state:snapshot(room)});for(const p of room.players)if(p.ws?.readyState===1)p.ws.send(message);}
function tell(ws,type,message){if(ws.readyState===1)ws.send(JSON.stringify({type,message}));}
function nextTurn(room,from){if(room.players.filter(p=>p.active).length===0){settle(room);return}const start=room.players.findIndex(p=>p.id===from);for(let i=1;i<=room.players.length;i++){const p=room.players[(start+i)%room.players.length];if(p.active){room.turn=p.id;return}}}
function settle(room){for(const p of room.players)p.score+=p.roundScore;const winner=room.players.find(p=>p.score>=200);if(winner){room.gameOver=true;room.started=false;room.winnerName=winner.name;room.turn=null;room.lastMessage=`${winner.name} chegou a 200 pontos e venceu!`;return}room.lastMessage='Pontos garantidos. Próxima rodada!';roundStart(room);}
function action(room,p,type){if(room.gameOver){if(type==='newGame'&&p.id===room.hostId){room.gameOver=false;room.winnerName='';room.round=0;for(const x of room.players)x.score=0;roundStart(room)}return}if(!room.started||room.turn!==p.id||!p.active)return;
  if(type==='stop'){p.active=false;p.waiting=false;room.lastMessage=`${p.name} garantiu ${p.roundScore} pontos.`;nextTurn(room,p.id);return}
  if(type==='draw'){if(!room.deck.length){settle(room);return}const value=room.deck.pop();if(typeof value==='number'&&p.cards.some(c=>c.value===value)){p.cards.push({value,duplicate:true});p.busted=true;p.active=false;p.roundScore=0;room.lastMessage=`${p.name} repetiu o ${value} e estourou!`;nextTurn(room,p.id);return}p.cards.push({value,duplicate:false});if(value==='+5')p.roundScore+=5;else if(value==='×2')p.roundScore*=2;else p.roundScore+=value;const distinct=p.cards.filter(c=>typeof c.value==='number'&&!c.duplicate).length;if(distinct>=7){p.roundScore+=15;p.active=false;room.lastMessage=`${p.name} fez Scholz 7: +15 pontos extras!`;nextTurn(room,p.id);return}room.lastMessage=`${p.name} revelou ${value}.`;nextTurn(room,p.id);}
}
wss.on('connection',ws=>{ws.isAlive=true;ws.on('pong',()=>ws.isAlive=true);ws.on('message',raw=>{let msg;try{msg=JSON.parse(raw.toString())}catch{return tell(ws,'error','Mensagem inválida.')}if(msg.type==='join'){if(ws.room)return;const name=String(msg.name||'').trim().replace(/[<>]/g,'').slice(0,18);if(!name)return tell(ws,'error','Digite um nome para entrar.');let code=String(msg.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);let room;if(code){room=rooms.get(code);if(!room)return tell(ws,'error','Não encontramos essa sala. Confira o código do convite.');}else{code=makeCode();room={code,hostId:null,players:[],round:0,deck:[],turn:null,started:false,gameOver:false,winnerName:'',lastMessage:'Aguardando jogadores.'};rooms.set(code,room)}if(room.players.some(p=>p.online&&p.name.toLowerCase()===name.toLowerCase()))return tell(ws,'error','Esse nome já está sendo usado nesta sala. Escolha outro.');if(room.players.filter(p=>p.online).length>=8)return tell(ws,'error','Esta mesa já está cheia (8 jogadores).');const id=Math.random().toString(36).slice(2,10);const player={id,name,score:0,roundScore:0,cards:[],active:false,busted:false,waiting:true,online:true,ws};if(!room.hostId)room.hostId=id;room.players.push(player);ws.room=code;ws.playerId=id;if(room.players.filter(p=>p.online).length>=2&&!room.started&&!room.gameOver)roundStart(room);ws.send(JSON.stringify({type:'joined',playerId:id,code,state:snapshot(room)}));broadcast(room);return}const room=rooms.get(ws.room),p=room?.players.find(x=>x.id===ws.playerId);if(!room||!p)return;if(msg.type==='draw'||msg.type==='stop'||msg.type==='newGame'){action(room,p,msg.type);broadcast(room)}});
  ws.on('close',()=>{const room=rooms.get(ws.room);if(!room)return;const p=room.players.find(x=>x.id===ws.playerId);if(p){p.online=false;p.active=false;p.waiting=false;if(room.turn===p.id)nextTurn(room,p.id);room.players=room.players.filter(x=>x.online);if(!room.players.length){rooms.delete(room.code);return}if(room.hostId===p.id)room.hostId=room.players[0].id;if(room.started&&room.players.filter(x=>x.active).length===0)settle(room);broadcast(room)}});
});
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue}ws.isAlive=false;ws.ping()}},25000);wss.on('close',()=>clearInterval(heartbeat));
server.listen(PORT,'0.0.0.0',()=>console.log(`Scholz 7 listening on ${PORT}`));

