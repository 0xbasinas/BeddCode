/**
 * The page behind `/metrics/dashboard`. It carries no data: it asks for the relay password, keeps
 * it for this tab only, and fetches `/metrics/summary` with it. Everything is drawn here, with no
 * outside scripts, fonts or images.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BeddCode speed</title>
<style>
:root{--bg:#fafaf9;--card:#fff;--ink:#1c1917;--muted:#78716c;--line:#e7e5e4;--accent:#4f6bed;--warm:#16a34a;--cold:#d97706;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1c1c1a;--ink:#f5f5f4;--muted:#a8a29e;--line:#2e2d2a;--accent:#8fa2ff;--warm:#4ade80;--cold:#fbbf24;--bad:#f87171}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:20px;margin:0}h2{font-size:13px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin:28px 0 10px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.sub{color:var(--muted);font-size:13px;margin:4px 0 0}
select,input,button{font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:7px 10px}
button{cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.card h3{margin:0 0 2px;font-size:14px}.card .hint{color:var(--muted);font-size:12px;margin-bottom:8px}
.big{display:flex;gap:18px;align-items:baseline}.big b{font-size:26px;font-variant-numeric:tabular-nums}.big span{color:var(--muted);font-size:12px}
svg{display:block;width:100%;height:46px;margin-top:8px}
.vs{display:flex;flex-direction:column;gap:6px}
.bar{display:grid;grid-template-columns:48px 1fr 70px;gap:8px;align-items:center;font-size:13px}
.bar i{display:block;height:10px;border-radius:5px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-variant-numeric:tabular-nums}
th,td{padding:8px 10px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:600;font-size:12px}
.scroll{overflow-x:auto}
.login{max-width:340px;margin:20vh auto 0;text-align:center}.login input{width:100%;margin:12px 0}
.err{color:var(--bad);min-height:1.4em}
.empty{color:var(--muted);padding:24px;text-align:center}
[hidden]{display:none!important}
</style>
</head>
<body>
<main>
<form class="login" id="login">
  <h1>BeddCode speed</h1>
  <p class="sub">Enter your relay password. It stays in this tab only.</p>
  <input id="pw" type="password" autocomplete="current-password" placeholder="Relay password" required>
  <button>Open</button>
  <p class="err" id="err"></p>
</form>
<div id="app" hidden>
  <header>
    <div><h1>BeddCode speed</h1><p class="sub" id="meta"></p></div>
    <div><select id="days"><option value="1">Last day</option><option value="7" selected>Last 7 days</option><option value="30">Last 30 days</option></select>
    <button id="reload">Refresh</button> <button id="out">Lock</button></div>
  </header>
  <h2>The ones that matter</h2>
  <div class="grid" id="cards"></div>
  <h2>First open vs reopen</h2>
  <div class="grid" id="resume"></div>
  <h2>Everything</h2>
  <input id="filter" placeholder="Filter by name, platform or route" style="width:100%;margin-bottom:10px">
  <div class="scroll"><table><thead><tr><th>Measurement</th><th>Platform</th><th>Route</th><th>Start</th><th>Count</th><th>p50</th><th>p95</th><th>Max</th></tr></thead><tbody id="rows"></tbody></table></div>
</div>
</main>
<script>
(function(){
var KEY=[['replay.ms','Catching up','How long a device takes to load the thread history after it connects'],['connect.ms','Connecting','From opening the app to talking to your computer'],['thread.open.ms','Opening a thread','Tap to a thread being on screen']];
var $=function(id){return document.getElementById(id)};
var pw=null,data=null;
try{pw=sessionStorage.getItem('pw')}catch(e){}
function ms(v){return v>=1000?(v/1000).toFixed(v>=10000?0:1)+' s':Math.round(v)+' ms'}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function svg(tag,attrs){var e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(var k in attrs)e.setAttribute(k,attrs[k]);return e}
async function load(){
  var r=await fetch('/metrics/summary?days='+$('days').value,{headers:{Authorization:'Bearer '+pw},cache:'no-store'});
  if(r.status===401){lock('That password is not right.');return}
  if(r.status===503){lock('Set RELAY_PASSWORD on the relay first.');return}
  if(!r.ok){lock('The relay answered '+r.status+'.');return}
  data=await r.json();
  try{sessionStorage.setItem('pw',pw)}catch(e){}
  $('login').hidden=true;$('app').hidden=false;draw();
}
function lock(msg){
  pw=null;try{sessionStorage.removeItem('pw')}catch(e){}
  $('app').hidden=true;$('login').hidden=false;$('err').textContent=msg||'';
}
function spark(points,color){
  var s=svg('svg',{viewBox:'0 0 200 46',preserveAspectRatio:'none'});
  if(points.length<2)return s;
  var max=Math.max.apply(null,points.map(function(p){return p.v}))||1;
  var d=points.map(function(p,i){return(i?'L':'M')+(i/(points.length-1)*200).toFixed(1)+' '+(42-p.v/max*38).toFixed(1)}).join(' ');
  s.appendChild(svg('path',{d:d,fill:'none',stroke:color,'stroke-width':2,'vector-effect':'non-scaling-stroke','stroke-linejoin':'round'}));
  return s;
}
function trend(name){
  var byDay={};
  data.daily.filter(function(p){return p.name===name}).forEach(function(p){
    var g=byDay[p.day]||(byDay[p.day]={w:0,n:0});g.w+=p.p50*p.count;g.n+=p.count;
  });
  return Object.keys(byDay).sort().map(function(day){return{v:byDay[day].w/byDay[day].n}});
}
function merge(rows){
  var n=0,w50=0,w95=0;
  rows.forEach(function(r){n+=r.count;w50+=r.p50*r.count;w95+=r.p95*r.count});
  return n?{count:n,p50:w50/n,p95:w95/n}:null;
}
function draw(){
  $('meta').textContent=data.samples+' measurements in the last '+data.days+(data.days===1?' day':' days');
  var cards=$('cards');cards.textContent='';
  var shown=0;
  KEY.forEach(function(k){
    var m=merge(data.rows.filter(function(r){return r.name===k[0]}));
    if(!m)return;shown++;
    var c=el('div','card');c.appendChild(el('h3','',k[1]));c.appendChild(el('div','hint',k[2]));
    var big=el('div','big');
    var a=el('div');a.appendChild(el('b','',ms(m.p50)));a.appendChild(el('span','',' typical'));
    var b=el('div');b.appendChild(el('b','',ms(m.p95)));b.appendChild(el('span','',' slowest 1 in 20'));
    big.appendChild(a);big.appendChild(b);c.appendChild(big);
    c.appendChild(spark(trend(k[0]),'var(--accent)'));
    c.appendChild(el('div','hint',m.count+' samples, typical time per day'));
    cards.appendChild(c);
  });
  if(!shown)cards.appendChild(el('div','empty','Nothing yet. Turn on speed measurements in the desktop app, use the apps for a bit, then refresh.'));
  var res=$('resume');res.textContent='';
  KEY.forEach(function(k){
    var cold=merge(data.rows.filter(function(r){return r.name===k[0]&&r.resume==='cold'}));
    var warm=merge(data.rows.filter(function(r){return r.name===k[0]&&r.resume==='warm'}));
    if(!cold&&!warm)return;
    var c=el('div','card');c.appendChild(el('h3','',k[1]));
    var max=Math.max(cold?cold.p50:0,warm?warm.p50:0)||1;
    var box=el('div','vs');
    [['Cold',cold,'var(--cold)'],['Warm',warm,'var(--warm)']].forEach(function(x){
      var row=el('div','bar');row.appendChild(el('span','',x[0]));
      var track=el('div');var bar=el('i');bar.style.background=x[2];bar.style.width=(x[1]?Math.max(2,x[1].p50/max*100):0)+'%';track.appendChild(bar);
      row.appendChild(track);row.appendChild(el('span','',x[1]?ms(x[1].p50):'none'));box.appendChild(row);
    });
    c.appendChild(box);res.appendChild(c);
  });
  if(!res.children.length)res.appendChild(el('div','empty','No first-open or reopen data yet.'));
  table();
}
function table(){
  var q=$('filter').value.trim().toLowerCase();
  var body=$('rows');body.textContent='';
  data.rows.filter(function(r){return!q||(r.name+' '+r.platform+' '+r.route+' '+r.resume).toLowerCase().indexOf(q)>=0})
    .sort(function(a,b){return a.name<b.name?-1:a.name>b.name?1:b.count-a.count}).forEach(function(r){
      var tr=el('tr');
      [r.name,r.platform,r.route||'-',r.resume||'-',r.count,ms(r.p50),ms(r.p95),ms(r.max)].forEach(function(v){tr.appendChild(el('td','',String(v)))});
      body.appendChild(tr);
    });
}
$('login').addEventListener('submit',function(e){e.preventDefault();pw=$('pw').value;$('pw').value='';load().catch(function(){lock('Could not reach the relay.')})});
$('days').addEventListener('change',function(){load()});
$('reload').addEventListener('click',function(){load()});
$('out').addEventListener('click',function(){lock('')});
$('filter').addEventListener('input',function(){if(data)table()});
if(pw)load().catch(function(){lock('')});
})();
</script>
</body>
</html>`
