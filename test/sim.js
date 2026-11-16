const fs=require('fs'), vm=require('vm'), zlib=require('zlib'), os=require('os'), path=require('path');
const sdt=require('/tmp/zomni/resource/document-worker/structured-document-text.js');
const CACHE=process.argv[2]||path.join(os.homedir(),'Zotero/storage/KKDQSWA2/.zotero-sdt-cache');
function assert(c,m){ if(!c){ console.error('ASSERT FAIL:',m); process.exit(1);} }

const prefs={'aireader.apiFormat':'chat','aireader.baseURL':'https://api.example.com/v1','aireader.apiKey':'sk','aireader.model':'m',
 'aireader.language':'中文','aireader.temperature':'0.3','aireader.maxChars':60000};
let opened=null, savedAnnotation=null, lastBody=null, fetchMode='ok';

function sseStream(txt){ const parts=[]; for(let i=0;i<txt.length;i+=9)parts.push(txt.slice(i,i+9));
 const frames=parts.map(p=>'data: '+JSON.stringify({choices:[{delta:{content:p}}]})+'\n').concat(['data: [DONE]\n']);
 const enc=new TextEncoder(); let i=0;
 return {getReader(){return {async read(){ if(i>=frames.length)return{done:true}; return {done:false,value:enc.encode(frames[i++])};}};}};
}
const fetchMock=async(url,opts)=>{
 if(/\/models$/.test(url)) return {ok:true,status:200,statusText:'OK',async text(){return JSON.stringify({data:[{id:'Opus 5.5'},{id:'claude-opus-5-5'},{id:'DeepSeek-V4-Pro'}]});}};
 lastBody=JSON.parse(opts.body);
 if(fetchMode==='notjson') return {ok:true,status:200,statusText:'OK',body:null,async text(){return '<html>not json</html>';},async json(){throw new Error('x');}};
 if(lastBody.stream){ const full='结论见 [B5]，建议高亮 [[hl:5]] 并批注 [[note:9|重点]]。';
   return {ok:true,status:200,statusText:'OK',body:sseStream(full),async text(){return '';}}; }
 return {ok:true,status:200,statusText:'OK',async text(){return JSON.stringify({choices:[{message:{content:'普通回答 [B3]'}}]});}};
};

function stubEl(){ const e={children:[],className:'',style:{},dataset:{},_text:'',
  classList:{add(){},remove(){},toggle(){}}, setAttribute(){}, addEventListener(){},
  appendChild(c){e.children.push(c); return c;}, createdBy:null,
  get childNodes(){return e.children;},
  set textContent(v){ e._text=v; if(v==='')e.children=[]; }, get textContent(){return e._text;} };
  return e; }
function collect(node, cls, acc){ acc=acc||[]; for(const c of (node.children||[])){ if(c && c.className===cls) acc.push(c); collect(c,cls,acc);} return acc; }
const doc={ createElement:()=>stubEl(), createElementNS:()=>stubEl(), createTextNode:(t)=>({text:t}),
  getElementById:()=>null, head:stubEl(), documentElement:stubEl() };

const ctx={ Zotero:{ debug:()=>{}, Prefs:{get:k=>prefs[k]}, DataDirectory:{dir:'/tmp/x'},
  SDT:{ getReader: async ()=> sdt.openStructuredDocumentTextPack(fs.readFileSync(CACHE),{inflate:b=>zlib.inflateRawSync(b)}) },
  Reader:{ open: async (id,loc)=>{opened={id,loc};}, registerEventListener(){}, unregisterEventListener(){} },
  ItemPaneManager:{registerSection(){},unregisterSection(){}}, PreferencePanes:{register:async()=>'p',unregister(){}},
  Utilities:{Internal:{openPreferences(){}}, generateObjectKey:()=>'ABCD1234'},
  Items:{getAsync:async()=>({attachmentText:''})},
  Annotations:{ saveFromJSON: async (att,json)=>{ savedAnnotation={att:att.key,json}; return {key:json.key}; } },
 }, PathUtils:{join:(...a)=>a.join('/')},
 IOUtils:{async exists(){return false;},async readUTF8(){return '';},async writeUTF8(){},async makeDirectory(){}},
 fetch:fetchMock, console, setTimeout, TextDecoder, TextEncoder, Services:{scriptloader:{}},
 marked:require('../content/vendor/marked.min.js'), katex:require('../content/vendor/katex/katex.min.js') };
ctx.AIReader=undefined; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname,'..','content','aireader.js'),'utf8'), ctx, {filename:'aireader.js'});
const A=ctx.AIReader; A.init({id:'ai@x',version:'0.3.0',rootURI:'file:///p/'});

(async()=>{
 const blocks=await A.extractBlocks(1);
 console.log('blocks:',blocks.length,'| all have pageHeight:',blocks.every(b=>b.pageHeight>0));
 assert(blocks.every(b=>b.pageHeight>0),'pageHeight present');
 const byId=new Map(blocks.map(b=>[b.id,b]));

 // context includes figure index
 const ctxText=A.buildContext(blocks);
 console.log('context has figure index:', ctxText.includes('Figures/tables'));
 assert(ctxText.includes('[B'),'context has blocks');

 // sortIndex format
 const posBlock=blocks.find(b=>b.position);
 const si=A.sortIndex(posBlock);
 console.log('sortIndex:',si);
 assert(/^\d{5}\|\d{6}\|\d{5}$/.test(si),'sortIndex format');

 // applyAnnotation shape
 await A.applyAnnotation({key:'ATT',libraryID:1}, posBlock, {type:'highlight',comment:'hi'});
 console.log('saved annotation:',JSON.stringify(savedAnnotation.json).slice(0,160));
 assert(savedAnnotation.json.key==='ABCD1234','key set');
 assert(savedAnnotation.json.color==='#ffd400','color yellow');
 assert(savedAnnotation.json.position===posBlock.position,'position == block.position');
 assert(/^\d{5}\|\d{6}\|\d{5}$/.test(savedAnnotation.json.sortIndex),'ann sortIndex format');

 // enhanceMessage: citation + hl + note parsing → children built
 const state={ doc, blocks, attachment:{id:7,key:'K'}, chatMsgs:stubEl() };
 const bubble=stubEl();
 const b5=byId.get(5), b9=byId.get(9);
 const sample='看 [B'+b5.id+']，高亮 [[hl:'+b5.id+']] 批注 [[note:'+b9.id+'|重点]] 完';
 A._renderLines(state, bubble, sample);
 const refs=collect(bubble,'aireader-ref');
 const applies=collect(bubble,'aireader-apply');
 console.log('refs:',refs.length,'applies:',applies.length);
 assert(refs.length===1,'one citation badge');
 assert(applies.length===2,'two apply buttons (hl+note)');
 // markdown: bold + bullet list
 const bubble2=stubEl();
 A._renderLines(state, bubble2, '**结论**\n- 第一点 [B'+b5.id+']\n- 第二点');
 const uls=collect(bubble2,'aireader-md-ul');
 assert(uls.length===1 && uls[0].children.length===2,'bullet list rendered');
 console.log('markdown list items:',uls[0].children.length);

 // streaming end-to-end via onChatSend
 const body={}; const st={ item:null, attachment:{id:7,key:'K2',libraryID:1}, blocks, doc, body:null,
   status:stubEl(), chatMsgs:stubEl(), input:{value:''}, send:stubEl(), modelPill:stubEl(), preview:stubEl(),
   streaming:false, cancel:false };
 st.body=body;
 A._bodyState.set(body, st); A._chatStore.set('K2',[]);
 await A.onChatSend(body,'总结一下');
 const hist=A._chatStore.get('K2');
 assert(lastBody&&lastBody.stream===true,'chat streams');
 console.log('history after send:',hist.length,'| assistant has directives:',/\[\[hl:/.test(hist[1].content));
 assert(hist.length===2 && hist[0].role==='user' && hist[1].role==='assistant','history recorded');

 // retrieval context (TF-IDF): returns block-tagged text relevant to query
 const rc=A.buildRetrievedContext(blocks, 'vision encoder pretraining');
 assert(rc.includes('[B')&&rc.length>0,'retrieved context non-empty');
 console.log('retrieved context chars:',rc.length);

 // tokenizer handles latin + CJK
 const tk=A.tokenize('Vision 编码器 BERT');
 assert(tk.includes('vision')&&tk.includes('bert')&&tk.includes('编')&&tk.includes('码'),'tokenize latin+cjk');

 // note HTML generation
 const noteHtml=A.historyToHTML(st, [{role:'user',content:'问题?'},{role:'assistant',content:'**要点**\n- a [B5]\n- b'}]);
 assert(/<h1>/.test(noteHtml)&&/<strong>要点<\/strong>/.test(noteHtml)&&/<li>/.test(noteHtml)&&/\(p/.test(noteHtml),'note HTML has heading/bold/list/citation');
 console.log('note HTML ok, len',noteHtml.length);

 // auto-apply directives → creates annotations
 savedAnnotation=null; let applyCount=0;
 const origSave=ctx.Zotero.Annotations.saveFromJSON;
 ctx.Zotero.Annotations.saveFromJSON=async(a,j)=>{applyCount++; return {key:j.key};};
 const n=await A.autoApplyDirectives(st, 'x [[hl:'+b5.id+']] y [[note:'+b9.id+'|理由]] z');
 ctx.Zotero.Annotations.saveFromJSON=origSave;
 console.log('autoApply created:',n);
 assert(n===2&&applyCount===2,'autoApplyDirectives applied 2');

 // stop: shouldStop() halts streaming early
 let got=''; const full2=await A.callLLMStream([{role:'user',content:'x'}], d=>{got+=d;}, ()=>true);
 console.log('stop: delivered chars when immediately stopped =',got.length);
 assert(got.length===0,'shouldStop halts before any delta');

 // chat persistence shape
 let savedChat=null; const origW=ctx.IOUtils.writeUTF8;
 ctx.IOUtils.writeUTF8=async(p,c)=>{ if(/-chat\.json$/.test(p)) savedChat=JSON.parse(c); };
 await A.saveChat(st.attachment, hist);
 ctx.IOUtils.writeUTF8=origW;
 assert(savedChat&&Array.isArray(savedChat.messages),'saveChat writes messages array');
 console.log('chat persisted messages:',savedChat.messages.length);

 // ---- API format matrix: body shaping, extraction, stream delta ----
 for (const fmt of ['chat','responses','anthropic']) {
   prefs['aireader.apiFormat']=fmt;
   const body=JSON.parse(A._bodyFor(fmt,[{role:'system',content:'S'},{role:'user',content:'U'}],true));
   const url=A._endpointFor(fmt), hdr=A._headersFor(fmt);
   assert(body.stream===true,'stream flag '+fmt);
   if(fmt==='chat'){ assert(url.endsWith('/chat/completions'),'chat url'); assert(hdr.Authorization,'chat auth'); assert(body.messages.length===2,'chat msgs'); }
   if(fmt==='responses'){ assert(url.endsWith('/responses'),'resp url'); assert(Array.isArray(body.input),'resp input'); }
   if(fmt==='anthropic'){ assert(url.endsWith('/messages'),'ant url'); assert(hdr['x-api-key'],'ant key header'); assert(hdr['anthropic-version'],'ant version'); assert(body.system==='S','ant system split'); assert(body.messages.length===1&&body.messages[0].role==='user','ant msgs exclude system'); assert(body.max_tokens>0,'ant max_tokens'); }
   const sample = fmt==='chat'?{choices:[{message:{content:'X'}}]} : fmt==='responses'?{output:[{content:[{text:'X'}]}]} : {content:[{text:'X'}]};
   assert(A._extractContent(fmt,sample)==='X','extract '+fmt);
   const frame = fmt==='chat'?{choices:[{delta:{content:'d'}}]} : fmt==='responses'?{type:'response.output_text.delta',delta:'d'} : {type:'content_block_delta',delta:{type:'text_delta',text:'d'}};
   assert(A._streamDelta(fmt,frame)==='d','streamDelta '+fmt);
 }
 prefs['aireader.apiFormat']='chat';
 console.log('API format matrix (chat/responses/anthropic): OK');

 // maxTokens: unset/0 => chat uncapped, anthropic uses large fallback; >0 => applied everywhere
 delete prefs['aireader.maxTokens'];
 assert(JSON.parse(A._bodyFor('chat',[{role:'user',content:'U'}],true)).max_tokens===undefined,'chat uncapped when maxTokens unset');
 assert(JSON.parse(A._bodyFor('anthropic',[{role:'user',content:'U'}],true)).max_tokens===32000,'anthropic large fallback when uncapped');
 prefs['aireader.maxTokens']='0';
 assert(JSON.parse(A._bodyFor('chat',[{role:'user',content:'U'}],true)).max_tokens===undefined,'chat uncapped when maxTokens=0');
 prefs['aireader.maxTokens']='8000';
 assert(JSON.parse(A._bodyFor('chat',[{role:'user',content:'U'}],true)).max_tokens===8000,'chat respects maxTokens>0');
 assert(JSON.parse(A._bodyFor('anthropic',[{role:'user',content:'U'}],true)).max_tokens===8000,'anthropic respects maxTokens>0');
 delete prefs['aireader.maxTokens'];
 console.log('maxTokens cap behavior: OK');

 // _normBase: http->https for remote, keep localhost, add /v1 to bare host
 const ob=prefs['aireader.baseURL'];
 prefs['aireader.baseURL']='http://api.example.com'; assert(A._normBase()==='https://api.example.com/v1','remote http upgraded + /v1');
 prefs['aireader.baseURL']='http://localhost:11434'; assert(A._normBase()==='http://localhost:11434/v1','localhost stays http');
 prefs['aireader.baseURL']='https://api.openai.com/v1'; assert(A._normBase()==='https://api.openai.com/v1','https /v1 untouched');
 prefs['aireader.baseURL']=ob;
 console.log('_normBase upgrade: OK');

 // error reporting shows the REAL body, not a masked hint
 fetchMode='notjson';
 let errMsg='';
 try { await A.callLLM([{role:'user',content:'x'}]); } catch(e){ errMsg=e.message; }
 console.log('non-JSON error:',JSON.stringify(errMsg.slice(0,70)));
 assert(/响应不是 JSON/.test(errMsg)&&/html/.test(errMsg),'non-JSON error includes real body');
 fetchMode='ok';

 // model list fetch + parse
 const models=await A.fetchModels();
 console.log('models fetched:',models.length, models.slice(0,3).join(','));
 assert(models.includes('Opus 5.5')&&models.length===3,'fetchModels parses id list');

 // markdown + KaTeX rich HTML pipeline
 const rich=A._mathAndMarkdown('**粗** 与公式 $E=mc^2$ 和\n\n- 列表项 [B5]\n\n$$\\int_0^1 x\\,dx$$');
 assert(/<strong>粗<\/strong>/.test(rich),'markdown bold');
 assert(/<li>/.test(rich),'markdown list');
 assert(/katex/.test(rich),'katex rendered math');
 assert(/\[B5\]/.test(rich),'citation token preserved for linkify');
 console.log('rich markdown+katex: OK');

 // usage capture per format
 (()=>{ const m={}; A._captureUsage(m,{usage:{prompt_tokens:12,completion_tokens:34}}); assert(m.inTok===12&&m.outTok===34,'openai usage'); })();
 (()=>{ const m={}; A._captureUsage(m,{type:'message_start',message:{usage:{input_tokens:7}}}); A._captureUsage(m,{type:'message_delta',usage:{output_tokens:21}}); assert(m.inTok===7&&m.outTok===21,'anthropic usage'); })();
 console.log('usage capture: OK');

 // ---- vision: message shapes per format ----
 const vm1=A.buildVisionMessages('chat','中文','desc','data:image/png;base64,AAA');
 assert(vm1[1].content[1].image_url.url==='data:image/png;base64,AAA','chat vision image_url');
 const vm2=A.buildVisionMessages('anthropic','中文','desc','data:image/png;base64,AAA');
 assert(vm2[1].content[1].type==='image'&&vm2[1].content[1].source.data==='AAA','anthropic vision base64 stripped');
 console.log('vision message shapes: OK');

 // fig directive → fig button
 const b3=blocks.find(b=>b.type==='image'&&b.position)||blocks.find(b=>b.position);
 const figBubble=stubEl();
 A._renderLines(st, figBubble, '见这张图 [[fig:'+b3.id+']]');
 assert(collect(figBubble,'aireader-apply aireader-figbtn').length===1,'fig button rendered');
 console.log('fig button: OK');

 // explainFigure full flow (stub region render; callLLM via mock)
 const origRender=A.renderRegionDataURI;
 A.renderRegionDataURI=async()=>'data:image/png;base64,ZZZ';
 A._chatStore.set('K2', A._chatStore.get('K2')||[]);
 const before=(A._chatStore.get('K2')||[]).length;
 await A.explainFigure(st, b3);
 const after=A._chatStore.get('K2').length;
 A.renderRegionDataURI=origRender;
 console.log('explainFigure added msgs:',after-before);
 assert(after-before===2,'explainFigure appends user+assistant');

 // navigation
 await A.navigateTo(7, posBlock);
 assert(opened && Number.isInteger(opened.loc.position.pageIndex),'navigate shape');

 console.log('\nALL OK');
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
