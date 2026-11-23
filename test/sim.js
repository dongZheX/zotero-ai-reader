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

function stubEl(){ const e={children:[],className:'',style:{},dataset:{},_text:'',_ev:{},
  classList:{add(){},remove(){},toggle(){}}, setAttribute(){},
  addEventListener(t,h){ (e._ev[t]=e._ev[t]||[]).push(h); },
  dispatch(t){ for(const h of (e._ev[t]||[])) h({stopPropagation(){},preventDefault(){}}); },
  appendChild(c){e.children.push(c); if(c&&typeof c==='object')c.parentNode=e; return c;}, createdBy:null,
  querySelector(sel){ const cls=String(sel).replace(/^\./,''); const find=(n)=>{ for(const c of (n.children||[])){ if(c&&c.className===cls)return c; const r=find(c); if(r)return r;} return null; }; return find(e); },
  remove(){ if(e.parentNode&&e.parentNode.children){ const i=e.parentNode.children.indexOf(e); if(i>=0)e.parentNode.children.splice(i,1);} },
  get childNodes(){return e.children;},
  set textContent(v){ e._text=v; if(v==='')e.children=[]; }, get textContent(){return e._text;} };
  return e; }
function collect(node, cls, acc){ acc=acc||[]; for(const c of (node.children||[])){ if(c && c.className===cls) acc.push(c); collect(c,cls,acc);} return acc; }
const doc={ createElement:(t)=>{const e=stubEl(); e.namespaceURI=null; e.tagName=t; return e;},
  createElementNS:(ns,t)=>{const e=stubEl(); e.namespaceURI=ns; e.tagName=t; return e;}, createTextNode:(t)=>({text:t}),
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
 // sentence-level extraction: many fine-grained blocks, each sentence-sized (not
 // whole paragraphs) and carrying valid rects so a single sentence can be
 // highlighted / cited / jumped to.
 { const pos=blocks.filter(b=>b.position&&b.text);
   const avg=pos.reduce((s,b)=>s+b.text.length,0)/(pos.length||1);
   assert(blocks.length>200 && avg<400,'blocks are sentence-sized ('+Math.round(avg)+' chars avg)');
   assert(pos.every(b=>b.position.rects.every(r=>r.length===4&&r[2]>=r[0])),'every positioned block has valid rects');
   console.log('sentence-level extraction: '+blocks.length+' blocks, avg '+Math.round(avg)+' chars');
 }
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
 // multi-id citation ([B1, B2] / [B1–B2]) and B-prefixed directive ([[hl:B1]])
 { const tb=stubEl();
   A._renderLines(state, tb, '多引用 [B'+b5.id+', B'+b9.id+']，范围 [B'+b5.id+'–B'+b9.id+']，前缀 [[hl:B'+b5.id+']] 完');
   assert(collect(tb,'aireader-ref').length===4,'multi-id and range citations render a badge per id');
   assert(collect(tb,'aireader-apply').length===1,'B-prefixed [[hl:B..]] renders an apply button');
   console.log('multi-citation + B-prefix directives: OK');
 }
 // markdown: bold + bullet list
 const bubble2=stubEl();
 A._renderLines(state, bubble2, '**结论**\n- 第一点 [B'+b5.id+']\n- 第二点');
 const uls=collect(bubble2,'aireader-md-ul');
 assert(uls.length===1 && uls[0].children.length===2,'bullet list rendered');
 console.log('markdown list items:',uls[0].children.length);

 // GFM table rendered by the fallback line renderer (no marked needed)
 { const tb=stubEl();
   A._renderLines(state, tb, '结果如下：\n| 放置 | Avg |\n|---|---|\n| 每层 | 39.4 |\n| 第1-8层 | 45.0 |');
   const tables=collect(tb,'aireader-md-table');
   assert(tables.length===1,'one table rendered from pipe markdown');
   const cnt=(node,tag,acc=[])=>{for(const c of (node.children||[])){if(c&&c.tagName===tag)acc.push(c);cnt(c,tag,acc);}return acc;};
   assert(cnt(tables[0],'th').length===2,'table has 2 header cells');
   assert(cnt(tables[0],'td').length===4,'table has 4 body cells');
   console.log('table fallback render: OK');
 }

 // fenced code block in the fallback renderer: render as <pre>, never leak ``` lines
 { const tb=stubEl();
   A._renderLines(state, tb, '也就是说：\n```text\n环境说明\n环境状态 schema\n```\n结尾。');
   const pres=collect(tb,'aireader-md-pre');
   assert(pres.length===1,'fenced block rendered as one <pre>');
   const code=(pres[0].children||[])[0];
   assert(code && /环境说明/.test(code.textContent) && /环境状态 schema/.test(code.textContent),'code content preserved');
   assert(!/```/.test(code.textContent),'fence markers not inside the code');
   // no paragraph anywhere still contains a literal ``` line
   const leaked=collect(tb,'aireader-md-p').some(p=>/```/.test(p.textContent||''));
   assert(!leaked,'no paragraph leaks a literal ``` fence line');
   // unterminated fence: collect to EOF without throwing
   const tb2=stubEl();
   A._renderLines(state, tb2, '前言\n```js\nconst x=1;');
   assert(collect(tb2,'aireader-md-pre').length===1,'unterminated fence still renders a <pre>');
   console.log('fenced code fallback render: OK');
 }

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

 // removeAnnotation (toggle-off): erases via eraseTx, else Items.erase(id)
 { let erased=false; await A.removeAnnotation({eraseTx:async()=>{erased=true;}}); assert(erased,'removeAnnotation uses eraseTx');
   let byId=0; const savedErase=ctx.Zotero.Items.erase; ctx.Zotero.Items.erase=async(id)=>{byId=id;};
   await A.removeAnnotation({id:77}); ctx.Zotero.Items.erase=savedErase;
   assert(byId===77,'removeAnnotation falls back to Items.erase(id)');
   console.log('removeAnnotation toggle-off: OK');
 }

 // removeAnnotationsForBlock: sweeps EVERY AI-tagged annotation at the block's
 // sortIndex (applying both 划线 and 批注 stacks two highlights at one spot, so
 // a single eraseTx leaves one behind — "颜色浅了一下还在"). Non-AI annotations
 // and annotations at other spots are left untouched.
 { const si=A.sortIndex(posBlock); let erased=0;
   const mk=(sidx,ai)=>({annotationSortIndex:sidx, hasTag:t=>t==='AI'&&ai, async eraseTx(){erased++;}});
   const att={ getAnnotations:()=>[ mk(si,true), mk(si,true), mk(si,false), mk('99999|000000|00000',true) ] };
   const n=await A.removeAnnotationsForBlock(att, posBlock);
   assert(n===2 && erased===2,'removeAnnotationsForBlock erases both AI annotations at the spot only');
   console.log('removeAnnotationsForBlock sweep: OK');
 }

 // annotateSelection: existing highlight at the spot → append note into its
 // comment (AI 解释 on highlighted text writes a note, no duplicate); no
 // existing highlight → create a new highlight carrying the note.
 { let savedComment=null;
   const si='00003|000000|00123';
   const existing={ annotationSortIndex:si, annotationType:'highlight', annotationComment:'', _tags:[],
     addTag(t){this._tags.push(t);}, async saveTx(){savedComment=this.annotationComment;} };
   const attWith={ libraryID:1, getAnnotations:()=>[existing] };
   const attNone={ libraryID:1, getAnnotations:()=>[] };
   const origGet=ctx.Zotero.Items.get; let which=attWith;
   ctx.Zotero.Items.get=()=>which;
   savedAnnotation=null;
   const r1=await A.annotateSelection({itemID:7}, {sortIndex:si, text:'T', pageLabel:'3', position:{pageIndex:2}}, 'AI 解释：X');
   assert(r1.updated===true && /AI 解释：X/.test(savedComment) && existing._tags.includes('AI'),'annotateSelection writes note into existing highlight');
   which=attNone;
   const r2=await A.annotateSelection({itemID:7}, {sortIndex:si, text:'T', pageLabel:'3', position:{pageIndex:2}}, 'AI 解释：Y');
   ctx.Zotero.Items.get=origGet;
   assert(r2.updated===false && savedAnnotation && savedAnnotation.json.comment==='AI 解释：Y' && savedAnnotation.json.tags[0].name==='AI','annotateSelection creates new highlight+note when none exists');
   console.log('annotateSelection update/create: OK');
 }

 // explainSelectionText: the reader-popup "AI 解释" must be grounded — it injects
 // the paper's relevant blocks AND the prior conversation so the explanation
 // builds on earlier answers (not an isolated one-shot).
 { const origGet=ctx.Zotero.Items.get; ctx.Zotero.Items.get=()=>({id:7,key:'KX'});
   A._blockStore.set('KX', blocks);
   A._chatStore.set('KX', [{role:'user',content:'先前的问题'},{role:'assistant',content:'先前的回答ZZZ'}]);
   let seen=null; const origLLM=A.callLLM; A.callLLM=async(msgs)=>{ seen=msgs; return '解释文本'; };
   const out=await A.explainSelectionText({itemID:7}, 'vision encoder capacity');
   A.callLLM=origLLM; ctx.Zotero.Items.get=origGet;
   assert(out==='解释文本','explainSelectionText returns the answer');
   assert(seen && /论文相关段落/.test(seen[0].content) && /\[B/.test(seen[0].content),'explain system prompt carries retrieved paper context');
   assert(seen.some(m=>m.content==='先前的回答ZZZ'),'explain injects prior conversation history');
   assert(seen[seen.length-1].role==='user' && /vision encoder capacity/.test(seen[seen.length-1].content),'explain ends with the selection as the user turn');
   // streaming variant: deltas flow through onDelta and the grounded context is kept
   ctx.Zotero.Items.get=()=>({id:7,key:'KX'});
   let got2=''; let seen2=null; const origStream=A.callLLMStream;
   A.callLLMStream=async(msgs,onDelta)=>{ seen2=msgs; for(const ch of ['解','释','流']) onDelta(ch); return '解释流'; };
   const outS=await A.explainSelectionStream({itemID:7}, 'vision encoder capacity', d=>{got2+=d;});
   A.callLLMStream=origStream; ctx.Zotero.Items.get=origGet;
   assert(got2==='解释流' && outS==='解释流','explainSelectionStream streams deltas and returns full text');
   assert(seen2 && /论文相关段落/.test(seen2[0].content) && seen2.some(m=>m.content==='先前的回答ZZZ'),'streaming explain keeps paper context + history');
   console.log('explainSelectionText + stream grounding: OK');
 }

 // getUserAnnotations: reads highlights/underlines/notes with page + comment
 { const att={ getAnnotations:()=>[
     {annotationType:"highlight",annotationText:"vision encoder",annotationComment:"",annotationPageLabel:"3"},
     {annotationType:"note",annotationText:"",annotationComment:"关键结论",annotationPageLabel:"9"},
     {annotationType:"image",annotationText:"x",annotationComment:"",annotationPageLabel:"1"} ] };
   const ua=await A.getUserAnnotations(att);
   assert(ua.length===2,'getUserAnnotations skips image, keeps hl+note');
   assert(/p3/.test(ua[0])&&/vision encoder/.test(ua[0]),'annotation carries page + text');
   assert(/p9/.test(ua[1])&&/关键结论/.test(ua[1]),'note annotation carries comment');
   console.log('getUserAnnotations: OK');
 }

 // saveNoteFromText: appends to an existing AI-tagged note, else creates one
 { let created=null, saved=0; const notes=[];
   const fakeNote=()=>({ _note:"", _tags:[], setNote(h){this._note=h;}, getNote(){return this._note;}, addTag(t){this._tags.push(t);}, hasTag(t){return this._tags.includes(t);}, async saveTx(){saved++;} , isAttachment:()=>false, isRegularItem:()=>true });
   const parent={ libraryID:1, isAttachment:()=>false, isRegularItem:()=>true, getDisplayTitle:()=>"Paper", getNotes:()=>notes.map((n,i)=>i) };
   const origItem=ctx.Zotero.Item, origGet=ctx.Zotero.Items.get;
   ctx.Zotero.Item=function(){ const n=fakeNote(); created=n; return n; };
   ctx.Zotero.Items.get=(i)=>notes[i];
   const st3={ item:parent, attachment:{key:'K',id:7}, blocks };
   await A.saveNoteFromText(st3, "**要点** [B5]\n- a\n- b", "问题?");
   assert(created && created._tags.includes("AI Reader"),'new AI note tagged');
   assert(/<h1>/.test(created._note)&&/要点/.test(created._note),'note has title + content');
   notes.push(created); // now an AI note exists
   const firstLen=created._note.length;
   await A.saveNoteFromText(st3, "第二条回答", null);
   assert(created._note.length>firstLen && /<hr/.test(created._note),'second save appends to existing note');
   ctx.Zotero.Item=origItem; ctx.Zotero.Items.get=origGet;
   console.log('saveNoteFromText append/create: OK');
 }

 // retrieval context (TF-IDF): returns block-tagged text relevant to query
 const rc=A.buildRetrievedContext(blocks, 'vision encoder pretraining');
 assert(rc.includes('[B')&&rc.length>0,'retrieved context non-empty');
 // low-signal query (few/no matching tokens) must NOT collapse to headings-only
 // context — it falls back to the full bounded body so the model isn't fed a
 // bare table of contents (which made it refuse "只有章节目录…没有正文").
 const rcLow=A.buildRetrievedContext(blocks, '你试试');
 assert((rcLow.match(/\[B/g)||[]).length>5 && rcLow.length>1000,'low-signal query falls back to full body, not headings-only');
 console.log('retrieved context chars:',rc.length);

 // tokenizer handles latin + CJK
 const tk=A.tokenize('Vision 编码器 BERT');
 assert(tk.includes('vision')&&tk.includes('bert')&&tk.includes('编')&&tk.includes('码'),'tokenize latin+cjk');

 // note HTML generation
 const noteHtml=A.historyToHTML(st, [{role:'user',content:'问题?'},{role:'assistant',content:'**要点**\n- a [B5]\n- b'}]);
 assert(/<h1>/.test(noteHtml)&&/<strong>要点<\/strong>/.test(noteHtml)&&/<li>/.test(noteHtml)&&/>p\d|\(p/.test(noteHtml),'note HTML has heading/bold/list/citation');
 console.log('note HTML ok, len',noteHtml.length);

 // auto-apply directives: dedupe per block, category→colour, cap, idempotency
 { const origSave=ctx.Zotero.Annotations.saveFromJSON;
   let saves=[]; ctx.Zotero.Annotations.saveFromJSON=async(a,j)=>{ saves.push(j); return {key:j.key}; };

   // two DISTINCT blocks → 2 annotations; returns {count,keys,applied}
   saves=[]; const r1=await A.autoApplyDirectives(st, 'x [[hl:'+b5.id+']] y [[note:'+b9.id+'|理由]] z');
   assert(r1.count===2 && r1.keys.length===2 && r1.applied.length===2,'autoApply applies 2 distinct blocks');

   // dedupe: hl + note for the SAME block, with a category → ONE green highlight
   saves=[]; const r2=await A.autoApplyDirectives(st, 'method [[hl:'+b5.id+']] 以及 [[note:'+b5.id+'|因为快]]');
   assert(r2.count===1 && saves.length===1,'autoApply merges hl+note of one block into one annotation');
   assert(saves[0].comment==='因为快','merged annotation carries the note comment');
   assert(saves[0].color===A.CATEGORY_COLORS.method,'category method → green highlight');
   assert(r2.applied[0].category==='method','applied records the category');

   // cap limits how many are written
   saves=[]; const r3=await A.autoApplyDirectives(st, '[[hl:'+b5.id+']] [[hl:'+b9.id+']]', {cap:1});
   assert(r3.count===1,'autoApply respects opts.cap');

   // idempotency: a block already AI-annotated at its spot is skipped
   const si5=A.sortIndex(b5);
   const attIdem={ id:7, key:'K2', libraryID:1, getAnnotations:()=>[{annotationSortIndex:si5, hasTag:t=>t==='AI', key:'OLD'}] };
   const stIdem=Object.assign({}, st, {attachment:attIdem});
   saves=[]; const r4=await A.autoApplyDirectives(stIdem, '[[hl:'+b5.id+']]');
   assert(r4.count===0,'autoApply is idempotent — skips a block already AI-annotated');

   ctx.Zotero.Annotations.saveFromJSON=origSave;
   console.log('autoApplyDirectives dedupe/colour/cap/idempotency: OK');
 }

 // tool-schema shaping + tool-call parsing round-trip for all three formats
 { const chatTools=A._toolSchemas('chat'); assert(chatTools[0].type==='function'&&chatTools[0].function.name==='list_sections','chat tool schema shape');
   const antTools=A._toolSchemas('anthropic'); assert(antTools[0].name==='list_sections'&&antTools[0].input_schema,'anthropic tool schema shape');
   const respTools=A._toolSchemas('responses'); assert(respTools[0].type==='function'&&respTools[0].name==='list_sections','responses tool schema shape');
   const chatP=A._parseToolCalls('chat',{choices:[{message:{content:'',tool_calls:[{id:'c1',type:'function',function:{name:'read_section',arguments:'{"index":2}'}}]}}]});
   assert(chatP.calls.length===1&&chatP.calls[0].name==='read_section'&&chatP.calls[0].args.index===2,'chat tool-call parse');
   const antP=A._parseToolCalls('anthropic',{content:[{type:'text',text:'ok'},{type:'tool_use',id:'a1',name:'highlight',input:{id:5,category:'method'}}]});
   assert(antP.calls.length===1&&antP.calls[0].name==='highlight'&&antP.calls[0].args.category==='method'&&antP.text==='ok','anthropic tool-call parse');
   const respP=A._parseToolCalls('responses',{output:[{type:'function_call',call_id:'r1',name:'finish',arguments:'{}'}]});
   assert(respP.calls.length===1&&respP.calls[0].name==='finish','responses tool-call parse');
   console.log('tool schema + parse (chat/anthropic/responses): OK');
 }

 // agentAnnotate: native tool-calling loop — list_sections → read_section →
 // highlight×2 → finish; colour-coded, run recorded, undo/redo, tool blocks shown
 { const origFetch=ctx.fetch, origFL=A._fetchLLM, origSave=ctx.Zotero.Annotations.saveFromJSON;
   const store=[];
   ctx.Zotero.Annotations.saveFromJSON=async(a,j)=>{ const it={key:j.key, annotationSortIndex:j.sortIndex, color:j.color, hasTag:t=>t==='AI', eraseTx:async()=>{ const i=store.indexOf(it); if(i>=0) store.splice(i,1); }}; store.push(it); return {key:j.key}; };
   const sections=A._buildSections(blocks);
   const sec=sections.find(s=>s.blockIds.length>=2);
   const id1=sec.blockIds[0]; let id2=null; for(const id of sec.blockIds){ if(A.sortIndex(byId.get(id))!==A.sortIndex(byId.get(id1))){ id2=id; break; } }
   const script=[
     {choices:[{message:{content:null,tool_calls:[{id:'t1',type:'function',function:{name:'list_sections',arguments:'{}'}}]}}]},
     {choices:[{message:{content:null,tool_calls:[{id:'t2',type:'function',function:{name:'read_section',arguments:JSON.stringify({index:sec.index})}}]}}]},
     {choices:[{message:{content:null,tool_calls:[
        {id:'t3',type:'function',function:{name:'highlight',arguments:JSON.stringify({id:id1,category:'contribution',reason:'核心主张'})}},
        {id:'t4',type:'function',function:{name:'highlight',arguments:JSON.stringify({id:id2,category:'method',reason:'做法'})}}]}}]},
     {choices:[{message:{content:null,tool_calls:[{id:'t5',type:'function',function:{name:'finish',arguments:'{}'}}]}}]},
   ];
   let step=0;
   A._fetchLLM=async()=>{ const d=script[Math.min(step,script.length-1)]; step++; return {ok:true,status:200,async text(){return JSON.stringify(d);}}; };
   const att={ id:7, key:'KA', libraryID:1, getAnnotations:()=>store.slice() };
   const stA={ attachment:att, blocks, doc, status:stubEl(), chatMsgs:stubEl(), send:stubEl() };
   await A.agentAnnotate(stA);
   assert(stA._lastRun && stA._lastRun.keys.length===2,'agentAnnotate applied 2 sentence highlights via tools');
   assert(store.some(s=>s.color===A.CATEGORY_COLORS.contribution) && store.some(s=>s.color===A.CATEGORY_COLORS.method),'agentAnnotate colours by category');
   assert(collect(stA.chatMsgs,'aireader-tool').length>=4,'tool-interaction blocks rendered in the bubble');
   const removed=await A.undoRun(stA);
   assert(removed===2 && store.length===0,'undoRun erases exactly this run');
   const redone=await A.redoRun(stA);
   assert(redone===2 && store.length===2,'redoRun re-creates exactly what undo removed');
   A._fetchLLM=origFL; ctx.fetch=origFetch; ctx.Zotero.Annotations.saveFromJSON=origSave;
   console.log('agentAnnotate tool-loop + undo + redo: OK');
 }

 // agent is resilient: an unknown tool returns an error result (no crash), loop finishes
 { const origFL=A._fetchLLM, origSave=ctx.Zotero.Annotations.saveFromJSON;
   ctx.Zotero.Annotations.saveFromJSON=async(a,j)=>({key:j.key});
   const script=[
     {choices:[{message:{content:null,tool_calls:[{id:'u1',type:'function',function:{name:'bogus_tool',arguments:'{}'}}]}}]},
     {choices:[{message:{content:null,tool_calls:[{id:'u2',type:'function',function:{name:'finish',arguments:'{}'}}]}}]},
   ];
   let step=0; A._fetchLLM=async()=>{ const d=script[Math.min(step,script.length-1)]; step++; return {ok:true,status:200,async text(){return JSON.stringify(d);}}; };
   const stB={ attachment:{id:7,key:'KB',libraryID:1,getAnnotations:()=>[]}, blocks, doc, status:stubEl(), chatMsgs:stubEl(), send:stubEl() };
   let threw=false; try { await A.agentAnnotate(stB); } catch(e){ threw=true; }
   assert(!threw && stB._lastRun && stB._lastRun.keys.length===0,'agent survives an unknown tool and finishes with 0 annotations');
   A._fetchLLM=origFL; ctx.Zotero.Annotations.saveFromJSON=origSave;
   console.log('agent unknown-tool resilience: OK');
 }

 // _streamAnswer: accumulates tool-call fragments across streamed chat deltas
 { const origFL=A._fetchLLM;
   const sseFrames=(frames)=>{ const enc=new TextEncoder(); let i=0; return {getReader(){return {async read(){ if(i>=frames.length) return {done:true}; return {done:false, value: enc.encode('data: '+JSON.stringify(frames[i++])+'\n')}; }};}}; };
   const frames=[
     {choices:[{delta:{content:'思考…'}}]},
     {choices:[{delta:{tool_calls:[{index:0,id:'x1',function:{name:'read_section',arguments:'{"in'}}]}}]},
     {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'dex":2}'}}]}}]},
   ];
   A._fetchLLM=async()=>({ok:true,status:200,body:sseFrames(frames),async text(){return '';}});
   let got='';
   const r=await A._streamAnswer([{role:'user',content:'x'}], A._toolSchemas('chat'), d=>{got+=d;}, ()=>false, {});
   A._fetchLLM=origFL;
   assert(got==='思考…','_streamAnswer streams text deltas');
   assert(r.calls.length===1 && r.calls[0].name==='read_section' && r.calls[0].args.index===2,'_streamAnswer accumulates streamed tool-call fragments');
   console.log('_streamAnswer streamed tool-call accumulation: OK');
 }

 // list_figures / view_figure tools: the model can discover and "read" figures
 { delete prefs['aireader.serperKey']; assert(A._toolSchemas('chat').length===10,'tool schema: 5 paper + web_fetch + 3 scholar + finish (no web_search without Serper key)');
   const figBlocks=blocks.filter(b=>(b.type==='image'||b.type==='table')&&b.position);
   const c2={ sections:A._buildSections(blocks), byId, run:{keys:[],applied:[]}, tally:{}, reads:0 };
   const stF={ attachment:{id:7,key:'KF',libraryID:1}, blocks };
   const lf=await A._execTool(stF, c2, {name:'list_figures', args:{}});
   assert(JSON.parse(lf.output).length===figBlocks.length,'list_figures returns all figures/tables');
   if (figBlocks.length) {
     const origRender=A.renderRegionDataURI, origLLM=A.callLLM;
     A.renderRegionDataURI=async()=>'data:image/png;base64,ZZZ';
     A.callLLM=async(msgs)=>{ assert(Array.isArray(msgs[1].content),'view_figure builds a vision message'); return '图中准确率随规模上升'; };
     const vf=await A._execTool(stF, c2, {name:'view_figure', args:{id:figBlocks[0].id}});
     A.renderRegionDataURI=origRender; A.callLLM=origLLM;
     assert(/准确率随规模上升/.test(JSON.parse(vf.output).description),'view_figure returns the vision description');
   }
   console.log('list_figures + view_figure: OK ('+figBlocks.length+' figs)');
 }

 // buildContextBounded: whole body when it fits; head+tail with omission marker when over budget
 { const fits=A.buildContextBounded(blocks, 1000000);
   assert(fits.includes('[B'),'bounded context includes blocks when it fits');
   const over=A.buildContextBounded(blocks, 400);
   assert(/中间内容略/.test(over),'bounded context marks omitted middle when over budget');
   console.log('buildContextBounded: OK');
 }

 // _compactHistory: folds older turns into a rolling summary, keeps recent 12
 { const origLLM=A.callLLM; A.callLLM=async()=>'要点摘要X';
   const h=[]; for(let i=0;i<24;i++) h.push({role:i%2?'assistant':'user', content:'turn'+i});
   await A._compactHistory('KC', h);
   A.callLLM=origLLM;
   assert(h.length===12,'_compactHistory keeps the most recent 12 turns');
   assert(h[h.length-1].content==='turn23','_compactHistory preserves the latest turn');
   assert(A._histSummary.get('KC')==='要点摘要X','_compactHistory stores a rolling summary');
   console.log('_compactHistory: OK');
 }

 // _fetchLLM: retries once on a network error, never on an HTTP error
 { const origFetch=ctx.fetch; let calls=0;
   ctx.fetch=async()=>{ calls++; if(calls===1) throw new Error('Connection reset by peer'); return {ok:true,status:200,async text(){return '{}';}}; };
   const resp=await A._fetchLLM('https://x/v1/chat',{method:'POST'},{retries:1,timeoutMs:1000});
   assert(calls===2 && resp.ok,'_fetchLLM retries once on a network error then succeeds');
   calls=0; ctx.fetch=async()=>{ calls++; return {ok:false,status:500,async text(){return 'err';}}; };
   const r2=await A._fetchLLM('https://x/v1/chat',{method:'POST'},{retries:1});
   assert(calls===1 && r2.status===500,'_fetchLLM does not retry HTTP errors');
   ctx.fetch=origFetch;
   console.log('_fetchLLM timeout/retry: OK');
 }

 // _figureDigest: one-line vision description folded in (bounded)
 { const origRender=A.renderRegionDataURI, origLLM=A.callLLM;
   A.renderRegionDataURI=async()=>'data:image/png;base64,ZZZ';
   A.callLLM=async()=>'展示了准确率随层数上升';
   const figBlocks=blocks.filter(b=>(b.type==='image'||b.type==='table')&&b.position);
   const dig=await A._figureDigest({attachment:{id:7,key:'KF',libraryID:1}, blocks}, 2);
   A.renderRegionDataURI=origRender; A.callLLM=origLLM;
   if (figBlocks.length) assert(/图表视觉摘要/.test(dig)&&/展示了/.test(dig),'_figureDigest returns a vision digest');
   else assert(dig==='','_figureDigest empty when no figures');
   console.log('_figureDigest: OK ('+figBlocks.length+' figs)');
 }

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
   if(fmt==='anthropic'){ assert(url.endsWith('/messages'),'ant url'); assert(hdr['x-api-key'],'ant key header'); assert(hdr['anthropic-version'],'ant version'); assert(Array.isArray(body.system)&&body.system[0].text==='S'&&body.system[0].cache_control,'ant system split + cache_control'); assert(body.messages.length===1&&body.messages[0].role==='user','ant msgs exclude system'); assert(body.max_tokens>0,'ant max_tokens'); }
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

 // XHTML namespace: _el MUST create HTML elements (XUL createElement renders
 // text with a fallback font → "乱码" in the Zotero 7 main window).
 { const XHTML='http://www.w3.org/1999/xhtml';
   assert(A._el(doc,'div').namespaceURI===XHTML,'_el creates XHTML div (not XUL)');
   assert(A._el(doc,'button').namespaceURI===XHTML,'_el creates XHTML button');
   console.log('XHTML namespace for _el: OK');
 }

 // model menu legibility: items MUST get explicit inline colour + font so they
 // stay readable even when the reader panel inherits an icon font / undefined
 // --fill-primary (the "乱码" bug).
 { const C=A._menuColors(doc);
   assert(/^#[0-9a-f]{6}$/i.test(C.fg)&&/^#[0-9a-f]{6}$/i.test(C.bg),'_menuColors returns hex fg/bg');
   const wrap=stubEl(); const st2={doc,attachment:{key:'K2'},modelPill:stubEl()}; st2.modelList=['gpt-4o-mini','claude-opus-5-5'];
   await A.populateModels(st2, wrap);
   assert(wrap.children.length===2,'two model items rendered');
   const cs=wrap.children[0].style.cssText||'';
   assert(/font-family:/.test(cs),'model item has explicit font-family inline');
   assert(/color:#[0-9a-f]{6}/i.test(cs),'model item has explicit hex colour inline (not a var)');
   assert(!/var\(/.test(cs),'model item colour/font must not depend on CSS vars');
   assert(/flex:0 0 auto/.test(cs),'model item must not shrink (flex:0 0 auto) — else rows clip to a sliver');
   assert(/line-height:/.test(cs),'model item has explicit line-height');
   console.log('model menu inline styling: OK ('+C.fg+' on '+C.bg+', no-shrink)');
 }

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

 // ---- model-drawn artifacts (mermaid / svg / html) rendered inline ----
 // helper: run _renderArtifacts over one fenced block, return the replacement node
 function renderArtifact(cls, srcText){
   const code=stubEl(); code.className=cls; code.textContent=srcText;
   const pre=stubEl(); pre.tagName='pre'; pre.appendChild(code); code.parentNode=pre;
   const root=stubEl(); root.appendChild(pre); pre.parentNode=root;
   root.querySelectorAll=(sel)=> sel==='pre > code' ? [code] : [];
   let replaced=null; root.replaceChild=(nw,old)=>{ replaced={nw,old}; };
   A._renderArtifacts({doc,attachment:{id:7,key:'K'}}, root);
   return replaced;
 }
 // svg: injected inline into the wrapper (sanitize runs; stub keeps innerHTML)
 { const r=renderArtifact('language-svg','<svg viewBox="0 0 10 10"><rect/></svg>');
   assert(r && r.old.tagName==='pre','svg fenced block replaced');
   assert(/aireader-artifact/.test(r.nw.className) && /<svg/.test(r.nw.innerHTML||''),'svg injected inline');
 }
 // html: injected inline
 { const r=renderArtifact('language-html','<b>hi</b>');
   assert(r && /<b>hi<\/b>/.test(r.nw.innerHTML||''),'html injected inline');
 }
 // mermaid can't render in this environment → show readable, wrapping source
 { const r=renderArtifact('language-mermaid','graph TD; X-->Y');
   const srcDiv=collect(r.nw,'aireader-artifact-src');
   assert(srcDiv.length===1 && srcDiv[0].textContent==='graph TD; X-->Y','mermaid shown as wrapping source');
 }
 // the model is steered to SVG, and the heavy mermaid lib / iframe page are gone
 assert(/```svg/.test(A.systemPrompt('x')),'system prompt steers diagrams to svg');
 assert(/AI 设计套路/.test(A.systemPrompt('x'))&&/emoji/.test(A.systemPrompt('x')),'svg guidance avoids AI-design clichés');
 // de-AI style guide is injected into answers (anti-cliché + term/translation rules)
 { const sp=A.systemPrompt('x');
   assert(/表达风格/.test(sp)&&/AI 腔/.test(sp),'system prompt carries the style guide');
   assert(/gold/.test(sp)&&/生硬直译/.test(sp),'style guide covers term/translation (no gold→黄金)');
   assert(/彰显|赋能|值得注意的是/.test(A._styleGuide()),'style guide bans AI filler words');
 }
 // custom instructions from settings are appended to the system prompt
 { prefs['aireader.customPrompt']='请多用列表，保留英文术语';
   const sp=A.systemPrompt('x');
   assert(/用户自定义要求/.test(sp)&&/请多用列表/.test(sp),'custom prompt appended to system prompt');
   delete prefs['aireader.customPrompt'];
   assert(!/用户自定义要求/.test(A.systemPrompt('x')),'no custom block when setting is empty');
 }
 // auto API format by model name: claude→anthropic, openai→responses, else→chat
 assert(A._autoFmt('claude-opus-5-5')==='anthropic','claude → anthropic /messages');
 assert(A._autoFmt('gpt-5')==='responses' && A._autoFmt('o3-mini')==='responses','openai → /responses');
 assert(A._autoFmt('deepseek-chat')==='chat' && A._autoFmt('qwen2.5')==='chat','unknown/compat gateway → chat fallback');
 assert(A._autoFmt('gpt-oss-20b')==='chat' && A._autoFmt('gpt-oss-120b')==='chat','gpt-oss (open weights) → chat, not /responses');
 { const sf=prefs['aireader.apiFormat'], sm=prefs['aireader.model'];
   prefs['aireader.apiFormat']='auto'; prefs['aireader.model']='claude-sonnet-5-5';
   assert(A._fmt()==='anthropic','_fmt() auto resolves anthropic from model');
   prefs['aireader.model']='gpt-4o'; assert(A._fmt()==='responses','_fmt() auto resolves responses from model');
   prefs['aireader.apiFormat']='chat'; prefs['aireader.model']='claude-x'; assert(A._fmt()==='chat','explicit format overrides auto');
   prefs['aireader.apiFormat']=sf; prefs['aireader.model']=sm;
 }
 assert(!fs.existsSync(path.join(__dirname,'..','content','vendor','mermaid.min.js')),'heavy mermaid lib removed');
 assert(!fs.existsSync(path.join(__dirname,'..','content','artifact.html')),'dead iframe render page removed');
 // _sanitizeArtifact strips scripts/handlers but keeps <style> for SVG fidelity
 { const el=stubEl(); let removed=[];
   el.querySelectorAll=(sel)=> sel.indexOf('script')>=0 ? [{remove(){removed.push('script');}}] : [{attributes:[{name:'onclick',value:'x'}],removeAttribute(n){removed.push('attr:'+n);}}];
   A._sanitizeArtifact(el);
   assert(removed.includes('script')&&removed.includes('attr:onclick'),'_sanitizeArtifact removes script + on* handlers');
   assert(!/style/.test('script,iframe,object,embed,link,meta,base,form,input,button,foreignObject'),'<style> is NOT in the artifact strip list');
 }
 // a plain (non-artifact) code block is left untouched
 assert(renderArtifact('language-python','print(1)')===null,'non-artifact code block not replaced');
 // _artifactCut: hide the diagram source while streaming (returns prose before the fence)
 assert(A._artifactCut('文字说明\n```svg\n<svg></svg>\n```')==='文字说明\n','_artifactCut returns prose before ```svg');
 assert(A._artifactCut('前言\n```mermaid\ngraph')==='前言\n','_artifactCut handles an unclosed fence too');
 assert(A._artifactCut('普通回答，无图')===null,'_artifactCut null when no diagram fence');
 assert(A._artifactCut('```python\nx=1')===null,'_artifactCut ignores non-diagram code fences');
 // _fitSvg: drop fixed px size, synthesize a viewBox, cap width (fixes overflow)
 { const svg={ _attr:{width:'800',height:'600'}, getAttribute(n){return this._attr[n];}, setAttribute(n,v){this._attr[n]=v;}, removeAttribute(n){delete this._attr[n];}, style:{} };
   const wrap={ querySelector:()=>svg };
   A._fitSvg(wrap);
   assert(svg._attr.viewBox==='0 0 800 600','_fitSvg synthesizes viewBox from width/height');
   assert(svg._attr.width===undefined && svg._attr.height===undefined,'_fitSvg drops fixed px width/height');
   assert(svg.style.maxWidth==='100%','_fitSvg caps svg to container width');
 }
 // summary presets ask for an SVG diagram by default (deep-read skill)
 { const dr=A.SKILLS.find(s=>s.id==='deep-read');
   const sum=dr.presets.find(p=>p.label==='总结全文'), tri=dr.presets.find(p=>p.label==='三行摘要');
   assert(/```svg/.test(sum.q),'总结全文 preset requests an svg diagram');
   assert(!/```svg/.test(tri.q),'三行摘要 stays text-only');
 }
 console.log('artifacts (inline svg/html, stream-hide source, fit-width, summary-draws): OK');

 // ---- reading skills ----
 { assert(A.SKILLS.length>=5 && A.SKILLS.every(s=>s.id&&s.label&&s.inject&&Array.isArray(s.presets)&&s.presets.length),'SKILLS well-formed');
   delete prefs['aireader.skill'];
   assert(A._skillId()==='deep-read' && A.currentSkill().label==='精读理解','default skill = 精读理解');
   assert(/精读/.test(A._skillDirective()),'directive carries the current skill method');
   // switching skill changes the injected directive + agentInject
   prefs['aireader.skill']='peer-review';
   assert(A.currentSkill().id==='peer-review','skill pref switches current skill');
   assert(/评审|Soundness/.test(A._skillDirective()),'peer-review directive injected');
   assert(A.currentSkill().agentInject && /审稿/.test(A.currentSkill().agentInject),'peer-review carries agentInject');
   // bad/empty pref falls back to the default skill
   prefs['aireader.skill']='nonsense'; assert(A._skillId()==='deep-read','unknown skill id → default');
   // renderChips: current skill presets + COMMON, with the common ones always present
   prefs['aireader.skill']='peer-review';
   const st3={ doc, body:{}, chips:stubEl() };
   A.renderChips(st3);
   const labels=collect(st3.chips,'aireader-chip').map(c=>c.textContent);
   assert(labels.length===A.currentSkill().presets.length+A.COMMON_PRESETS.length,'chips = skill presets + common');
   assert(labels.includes('评审总览')&&labels.includes('总结(含图表)'),'skill chip + common chip both present');
   prefs['aireader.skill']='quick'; A.renderChips(st3);
   const labels2=collect(st3.chips,'aireader-chip').map(c=>c.textContent);
   assert(labels2.includes('三句话')&&labels2.includes('总结(含图表)'),'common chips stay across skills');
   delete prefs['aireader.skill'];
   console.log('reading skills (SKILLS, directive, chips swap, common stay): OK');
 }

 // ---- reasoning / thought-signature round-trip (Claude thinking, OpenAI reasoning) ----
 { // anthropic: accumulate a thinking block + its signature, then replay it FIRST
   const racc={};
   A._streamReasoningDelta('anthropic',{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},racc);
   A._streamReasoningDelta('anthropic',{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'因为'}},racc);
   A._streamReasoningDelta('anthropic',{type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'SIG123'}},racc);
   const r=A._finalizeReasoning(racc);
   assert(r.length===1 && r[0].type==='thinking' && r[0].thinking==='因为' && r[0].signature==='SIG123','anthropic thinking+signature accumulated');
   const m1=[]; A._pushAssistantToolTurn('anthropic', m1, { text:'', calls:[{id:'t1',name:'list_sections',args:{}}], reasoning:r });
   const c=m1[0].content;
   assert(c[0].type==='thinking' && c[0].signature==='SIG123' && c[c.length-1].type==='tool_use','thinking replayed first, before tool_use');
   const p=A._parseToolCalls('anthropic',{content:[{type:'thinking',thinking:'t',signature:'s'},{type:'tool_use',id:'x',name:'n',input:{}}]});
   assert(p.reasoning.length===1 && p.reasoning[0].signature==='s','anthropic non-stream parse keeps thinking block');
 }
 { // responses: keep reasoning item, replay it (with id) before the function_call
   const racc={};
   A._streamReasoningDelta('responses',{type:'response.output_item.added',output_index:0,item:{type:'reasoning',id:'rs_1',summary:[]}},racc);
   const r=A._finalizeReasoning(racc);
   assert(r.length===1 && r[0].id==='rs_1','responses reasoning item captured');
   const m2=[]; A._pushAssistantToolTurn('responses', m2, { text:'', calls:[{id:'c1',name:'f',args:{}}], reasoning:r });
   assert(m2[0].type==='reasoning' && m2[0].id==='rs_1' && m2[1].type==='function_call','reasoning item replayed before function_call');
 }
 // a no-tools request (the wrap-up / plain chat) omits the tools field entirely
 assert(!/"tools"/.test(A._toolBody('chat',[{role:'user',content:'x'}],null,false)),'no tools field when tools is null (chat)');
 assert(!/"tools"/.test(A._toolBody('anthropic',[{role:'user',content:'x'}],[],false)),'no tools field when tools empty (anthropic)');
 // anthropic: generous max_tokens (no 8000 truncation) + prompt-cache on system
 { const o=JSON.parse(A._toolBody('anthropic',[{role:'system',content:'S'},{role:'user',content:'u'}],[],false));
   assert(o.max_tokens===32000,'anthropic tool-path max_tokens is 32000 (not 8000)');
   assert(Array.isArray(o.system)&&o.system[0].cache_control&&o.system[0].cache_control.type==='ephemeral','anthropic system carries ephemeral cache_control');
   // rolling cache breakpoint: the last message carries cache_control so multi-turn caches the conversation prefix
   const lastMsg=o.messages[o.messages.length-1];
   assert(Array.isArray(lastMsg.content)&&lastMsg.content[lastMsg.content.length-1].cache_control,'anthropic last (string) message wrapped with cache_control block');
 }
 // _anthropicCacheMsgs: marks the last block, keeps earlier turns clean, never mutates input
 { const live=[{role:'user',content:'q1'},{role:'assistant',content:[{type:'text',text:'a'},{type:'tool_use',id:'t',name:'n',input:{}}]}];
   const out=A._anthropicCacheMsgs(live);
   assert(!live[1].content[1].cache_control,'original live history not mutated');
   assert(out[out.length-1].content[1].cache_control&&out[out.length-1].content[1].cache_control.type==='ephemeral','cache_control added to last block of last message');
   assert(out[0].content==='q1','earlier turns left untouched (no breakpoint)');
 }
 // cache-hit tokens surfaced from usage
 { const m={}; A._captureUsage(m,{usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:900}}); assert(m.cacheRead===900,'cache_read surfaced'); }
 // meta line shows cache write (first turn) and cache read (later turns)
 { const mk=(meta)=>{ const msg=stubEl(); A.addMetaLine({doc},msg,meta,'x'); return collect(msg,'aireader-meta')[0].textContent; };
   assert(/写缓存 2\.0k/.test(mk({outTok:10,cacheWrite:2000})),'first turn shows cache write');
   assert(/命中缓存 1\.8k/.test(mk({outTok:10,cacheRead:1800})),'later turn shows cache hit');
   assert(!/缓存/.test(mk({outTok:10})),'no cache text when the API reports none');
 }
 // continuous reading context: read sections / figures live in global per-key stores,
 // replayed into the popup/agent via _priorContextForKey
 { A._readStore=new Map(); A._figStore=new Map();
   A._readFor('KZ').set(2,{title:'Method',text:'[B9 p3] foo'});
   A._figFor('KZ').set(9,{page:'4',kind:'图',desc:'a scatter plot'});
   const pc=A._priorContextForKey('KZ');
   assert(/已读资料/.test(pc)&&/Method/.test(pc)&&/foo/.test(pc)&&/scatter plot/.test(pc),'prior context replays read sections + figures');
   assert(/不要再 read_section/.test(pc),'prior context tells model not to re-read');
   // a different (unread) attachment yields no prior context
   assert(A._priorContextForKey('KW')==='','no prior context for an attachment nothing was read from');
   assert(A._priorContextForKey(null)==='','no prior context without a key');
   A._readStore=new Map(); A._figStore=new Map();
 }
 // continuous live history: _ensureLive rebuilds from text hist; rebuilds on key/fmt change
 { const sv=A._fmt; A._fmt=()=>'anthropic';
   A._chatStore=new Map(); A._chatStore.set('LK',[{role:'user',content:'q1'},{role:'assistant',content:'a1'}]);
   const st={ attachment:{key:'LK'} };
   A._ensureLive(st);
   assert(st.live && st.live.key==='LK' && st.live.fmt==='anthropic','live initialised with key+fmt');
   assert(st.live.messages.length===2 && st.live.messages[0].content==='q1','live seeded from text hist (text turns only)');
   // push a native tool turn (anthropic blocks) — survives to the next _ensureLive (no change)
   st.live.messages.push({role:'assistant',content:[{type:'tool_use',id:'t1',name:'read_section',input:{index:0}}]});
   st.live.messages.push({role:'user',content:[{type:'tool_result',tool_use_id:'t1',content:'sec0'}]});
   A._ensureLive(st);
   assert(st.live.messages.length===4,'live persists tool turns across _ensureLive when key+fmt unchanged');
   // tool_result (role:user, array content) is NOT a user round boundary
   assert(!A._isUserTurn(st.live.messages[3]) && A._isUserTurn(st.live.messages[0]),'tool_result user-role array is not a round boundary');
   // fmt change rebuilds from text hist, dropping format-specific tool turns
   A._fmt=()=>'chat'; A._ensureLive(st);
   assert(st.live.fmt==='chat' && st.live.messages.length===2,'fmt change rebuilds live from text hist');
   A._fmt=sv; A._chatStore=new Map();
 }
 // regen rollback: drop the last answer + its tool turns, keep the last user turn
 { const st={ live:{ key:'R', fmt:'chat', messages:[
     {role:'user',content:'q1'},{role:'assistant',content:'a1'},
     {role:'user',content:'q2'},{role:'assistant',content:'',tool_calls:[{id:'x'}]},{role:'tool',content:'r'},{role:'assistant',content:'a2'} ] } };
   A._rollbackLiveToLastUser(st);
   assert(st.live.messages.length===3 && st.live.messages[2].content==='q2','rollback keeps last user turn, drops its answer + tool turns');
 }
 // _turnsToText flattens all three formats to readable prose
 { const txt=A._turnsToText([
     {role:'user',content:'问题A'},
     {role:'assistant',content:'答A'},
     {role:'tool',content:'chatToolOut'},                                  // openai chat
     {type:'function_call',name:'read_section'},                            // responses
     {type:'function_call_output',output:'respToolOut'},
     {role:'assistant',content:[{type:'text',text:'答B'},{type:'tool_use',name:'view_figure'}]}, // anthropic
     {role:'user',content:[{type:'tool_result',content:'anthToolOut'}]} ]);
   assert(/用户：问题A/.test(txt)&&/助手：答A/.test(txt),'turnsToText: text turns');
   assert(/chatToolOut/.test(txt)&&/respToolOut/.test(txt)&&/anthToolOut/.test(txt),'turnsToText: tool outputs from all 3 formats');
   assert(/read_section/.test(txt)&&/view_figure/.test(txt),'turnsToText: tool call names');
   assert(/助手：答B/.test(txt),'turnsToText: anthropic text block attributed to assistant');
 }
 // _compactLive: summarises oldest whole rounds, keeps recent, never severs tool pairs; below trigger = no-op
 { const sv=A.callLLM; A.callLLM=async()=>'摘要内容';
   const small={ live:{ key:'C', fmt:'chat', messages:[{role:'user',content:'q'},{role:'assistant',content:'a'}] } };
   await A._compactLive(small, null);
   assert(small.live.messages.length===2,'compact is a no-op below the trigger');
   const big='x'.repeat(70000);
   const st={ live:{ key:'C', fmt:'chat', messages:[
     {role:'user',content:'oldQ'},{role:'assistant',content:big},
     {role:'user',content:'recentQ'},{role:'assistant',content:big} ] } };
   await A._compactLive(st, null);
   const m=st.live.messages;
   assert(A._isUserTurn(m[0]) && /早期阅读与对话摘要/.test(m[0].content) && /摘要内容/.test(m[0].content),'compact replaces older rounds with a summary note');
   assert(m.some(x=>x.content==='recentQ'),'compact keeps the most recent round');
   assert(m.length < 4,'compact shrank the history');
   A.callLLM=sv;
 }
 // wait ticker: shows a busy label while a silent phase runs, and clears its timer on stop
 { const st={ status:stubEl() };
   A._startWait(st,'正在思考…');
   assert(/正在思考…/.test(st.status.textContent)&&st._waitTimer,'startWait sets a busy label and arms a timer');
   A._stopWait(st);
   assert(!st._waitTimer,'stopWait clears the timer');
 }
 // drawing placeholder: single node reused across paints, shows elapsed, cleared when the fence closes
 { const st={ doc }; const el=stubEl();
   A._showDrawing(st, el); A._showDrawing(st, el);
   const draws=collect(el,'aireader-drawing');
   assert(draws.length===1,'only one drawing placeholder across repeated paints');
   assert(/正在绘制图示…/.test(draws[0].textContent),'drawing placeholder shows the label');
   A._clearDrawing(el);
   assert(collect(el,'aireader-drawing').length===0,'clearDrawing removes the placeholder');
 }
 // friendly errors: map common failures to an actionable hint, keep the raw text
 { const f=(msg)=>A._friendlyError(new Error(msg));
   assert(/超时/.test(f('The operation was aborted')),'abort/timeout → 超时 hint');
   assert(/Key/.test(f('HTTP 401 Unauthorized')),'401 → key hint');
   assert(/限流|额度/.test(f('HTTP 429 rate limit exceeded')),'429 → rate-limit hint');
   assert(/接口格式|格式/.test(f('Unexpected token < in JSON')),'non-JSON → format hint');
   assert(/连不上|网络/.test(f('网络请求失败（已重试）：Failed to fetch')),'network → connectivity hint');
   assert(f('Base URL 未设置')==='Base URL 未设置','already-clear messages pass through unchanged');
   assert(/原始信息/.test(f('HTTP 401 Unauthorized')),'raw text appended for diagnosis');
 }
 // retry button on a failed turn: re-sends the same text + opts, cleans up the failed turn
 { const calls=[]; const sv=A._send; A._send=(st,t,o)=>{ calls.push({t,o}); };
   const st={ doc, attachment:{key:'RT'}, chatMsgs:stubEl(), live:{key:'RT',fmt:'chat',messages:[{role:'user',content:'q'},{role:'assistant',content:'partial'}]} };
   const errMsg=stubEl(); const eb=stubEl(); eb.className='aireader-bubble'; errMsg.appendChild(eb);
   const userMsg=stubEl();
   A._addRetry(st, errMsg, userMsg, 'q', { broad:false });
   const btn=collect(errMsg,'aireader-action')[0];
   assert(btn&&/重试/.test(btn.textContent),'retry button added to the error bubble');
   btn.dispatch('click');
   assert(calls.length===1 && calls[0].t==='q' && calls[0].o.broad===false,'retry re-sends the same text + opts');
   assert(st.live.messages.length===0,'non-skipUser retry drops the failed user turn from live');
   A._send=sv;
 }
 console.log('reasoning round-trip + no-tools body: OK');

 // ---- parallel tool execution (read-only concurrent, writes serial) ----
 { const orig=A._execTool, origGet=A.getPref;
   let active=0, maxActive=0; const order=[];
   A._execTool=async(st,c,call)=>{ active++; maxActive=Math.max(maxActive,active); order.push(call.name); await new Promise(r=>setTimeout(r,5)); active--; return { output: JSON.stringify({ ok: call.name }), render: { label: call.name } }; };
   const calls=[{id:'1',name:'view_figure'},{id:'2',name:'view_figure'},{id:'3',name:'view_figure'},{id:'4',name:'highlight'}];
   A.getPref=(k)=> k==='maxParallelTools'?3:origGet.call(A,k);
   const slots=await A._runToolCalls({},{run:{keys:[]}},calls);
   assert(slots.length===4 && JSON.parse(slots[0].output).ok==='view_figure' && JSON.parse(slots[3].output).ok==='highlight','results aligned with calls');
   assert(maxActive>=2,'read-only calls run concurrently (maxParallelTools=3)');
   A.getPref=(k)=> k==='maxParallelTools'?1:origGet.call(A,k);
   active=0; maxActive=0;
   await A._runToolCalls({},{run:{keys:[]}},calls);
   assert(maxActive===1,'maxParallelTools=1 forces serial');
   // stop (state.cancel) short-circuits remaining tool calls without executing them
   let execed=0; A._execTool=async()=>{ execed++; return { output:'{}', render:{} }; };
   const cancelled=await A._runToolCalls({cancel:true},{run:{keys:[]}},calls);
   assert(execed===0,'cancel skips _execTool entirely');
   assert(cancelled.every(s=>/已取消/.test(s.output)),'cancelled calls return 已取消');
   A._execTool=orig; A.getPref=origGet;
   console.log('parallel tool execution (concurrent read-only, serial writes): OK');
 }

 // ---- web tools: web_search (Serper) + web_fetch ----
 // _htmlToText: strip markup, keep title + readable text
 const ht=A._htmlToText('<html><head><title>Hi &amp; Bye</title><style>x{}</style></head><body><nav>menu</nav><p>Hello <b>world</b></p><script>bad()</script><li>one</li></body></html>');
 assert(ht.title==='Hi & Bye','html title extracted + entity decoded');
 assert(/Hello world/.test(ht.text),'html body text kept');
 assert(!/bad\(\)/.test(ht.text) && !/menu/.test(ht.text),'script/nav stripped');
 assert(/• one/.test(ht.text),'list item bulletized');
 console.log('_htmlToText: OK');

 // tool gating: web_search only present when a Serper key is configured; web_fetch always
 delete prefs['aireader.serperKey'];
 let names=A._agentTools().map(t=>t.name);
 assert(!names.includes('web_search'),'no web_search without Serper key');
 assert(names.includes('web_fetch'),'web_fetch always available');
 prefs['aireader.serperKey']='test-serper-key';
 names=A._agentTools().map(t=>t.name);
 assert(names.includes('web_search')&&names.includes('web_fetch'),'web_search appears once Serper key is set');
 // web_search schema shaped per format
 const wsChat=A._toolSchemas('chat').find(t=>t.function&&t.function.name==='web_search');
 const wsAnth=A._toolSchemas('anthropic').find(t=>t.name==='web_search');
 assert(wsChat&&wsChat.function.parameters.required.includes('query'),'web_search chat schema');
 assert(wsAnth&&wsAnth.input_schema,'web_search anthropic schema (input_schema)');

 // webSearch: normalizes Serper response via stubbed _fetchLLM; errors without key
 { const origFL=A._fetchLLM;
   A._fetchLLM=async(url,opts)=>{ assert(/google\.serper\.dev/.test(url),'serper endpoint'); assert(opts.headers['X-API-KEY']==='test-serper-key','serper key header'); return {ok:true,status:200,async text(){return JSON.stringify({organic:[{title:'T1',link:'http://a',snippet:'s1'},{title:'T2',link:'http://b',snippet:'s2'}]});}}; };
   const rs=await A.webSearch('vacuum rlhf',2);
   assert(rs.length===2 && rs[0].title==='T1' && rs[0].link==='http://a','webSearch maps organic results');
   delete prefs['aireader.serperKey'];
   let threw=false; try{ await A.webSearch('x'); }catch(e){ threw=true; }
   assert(threw,'webSearch throws without key');
   prefs['aireader.serperKey']='test-serper-key';
   A._fetchLLM=origFL;
 }

 // _execTool routes web_search / web_fetch to render blocks
 { const origWS=A.webSearch, origWF=A.webFetch;
   A.webSearch=async()=>[{title:'R',link:'http://r',snippet:'snip'}];
   A.webFetch=async()=>({title:'Page',text:'body text here'});
   const r1=await A._execTool(st,{},{name:'web_search',args:{query:'q'}});
   assert(/联网搜索/.test(r1.render.label) && /1 条/.test(r1.render.outcome),'web_search tool block');
   assert(JSON.parse(r1.output)[0].link==='http://r','web_search output is JSON results');
   const r2=await A._execTool(st,{},{name:'web_fetch',args:{url:'https://example.com/p'}});
   assert(/抓取网页/.test(r2.render.label) && JSON.parse(r2.output).title==='Page','web_fetch tool block + output');
   const r3=await A._execTool(st,{},{name:'web_fetch',args:{url:'ftp://nope'}});
   assert(/✕/.test(r3.render.outcome),'web_fetch rejects non-http url');
   A.webSearch=origWS; A.webFetch=origWF;
 }

 // ---- scholarly discovery: lookup_paper / find_references / related_papers ----
 // tools present unconditionally (free APIs, no key needed), in all 3 formats
 { const names=A._agentTools().map(t=>t.name);
   assert(names.includes('lookup_paper')&&names.includes('find_references')&&names.includes('related_papers'),'scholar tools always present');
   for (const fmt of ['chat','anthropic','responses']) {
     const got=A._toolSchemas(fmt).map(t=>t.name||(t.function&&t.function.name));
     assert(got.includes('find_references'),'find_references in '+fmt+' schema');
   }
 }
 // _normS2 normalizes a Semantic Scholar paper; _fmtPaperList renders a readable block
 { const n=A._normS2({ title:'T', authors:[{name:'A'},{name:'B'}], year:2021, venue:'NeurIPS', citationCount:42, externalIds:{DOI:'10.1/x', ArXiv:'2101.00001'}, url:'http://u' });
   assert(n.title==='T'&&n.authors.length===2&&n.year===2021&&n.citations===42&&n.doi==='10.1/x'&&n.arxiv==='2101.00001','_normS2 maps fields');
   const body=A._fmtPaperList([n]);
   assert(/1\. T/.test(body)&&/A, B/.test(body)&&/被引 42/.test(body),'_fmtPaperList renders title+authors+citations');
   assert(A._fmtPaperList([])==='（无结果）','_fmtPaperList empty');
 }
 // _execTool routes the 3 scholar tools, mapping helper output to render + JSON
 { const oL=A.scholarLookup, oR=A.scholarReferences, oRel=A.scholarRelated;
   A.scholarLookup=async()=>({source:'s2',results:[{title:'P1',authors:['X'],year:2020,citations:5}]});
   A.scholarReferences=async()=>[{title:'Ref1',authors:['Y'],year:2018}];
   A.scholarRelated=async()=>({related:[{title:'Rel1'}],citedBy:[{title:'Cite1'},{title:'Cite2'}]});
   const rl=await A._execTool(st,{},{name:'lookup_paper',args:{query:'foo'}});
   assert(/查论文/.test(rl.render.label)&&JSON.parse(rl.output)[0].title==='P1','lookup_paper routes + JSON output');
   const rf=await A._execTool(st,{},{name:'find_references',args:{}});
   assert(/找参考文献/.test(rf.render.label)&&/1 条/.test(rf.render.outcome)&&JSON.parse(rf.output)[0].title==='Ref1','find_references routes (current paper)');
   const rr=await A._execTool(st,{},{name:'related_papers',args:{}});
   assert(/相关论文/.test(rr.render.label)&&/3 条/.test(rr.render.outcome)&&JSON.parse(rr.output).citedBy.length===2,'related_papers merges related+citedBy');
   // soft error path surfaces ✕ without throwing
   A.scholarReferences=async()=>{ throw new Error('Semantic Scholar 暂时限流'); };
   const re=await A._execTool(st,{},{name:'find_references',args:{}});
   assert(/✕ 失败/.test(re.render.outcome)&&/error/.test(re.output),'find_references soft-fails on throttle');
   A.scholarLookup=oL; A.scholarReferences=oR; A.scholarRelated=oRel;
   console.log('scholarly discovery tools: OK');
 }

 // _s2ResolveId: DOI / arXiv pass through; a title is matched via S2 (stubbed)
 { assert(await A._s2ResolveId('10.1145/3292500.3330701')==='DOI:10.1145/3292500.3330701','DOI → DOI: id');
   assert(await A._s2ResolveId('https://doi.org/10.1/abc')==='DOI:10.1/abc','doi.org URL → DOI: id');
   assert(await A._s2ResolveId('arXiv:2101.00001')==='ARXIV:2101.00001','arXiv → ARXIV: id');
   const oG=A._s2Get; A._s2Get=async(path)=>{ assert(/paper\/search\/match/.test(path),'title resolves via match endpoint'); return {data:[{paperId:'PID123',title:'T'}]}; };
   assert(await A._s2ResolveId('Some Paper Title')==='PID123','title → matched paperId');
   A._s2Get=oG;
 }
 delete prefs['aireader.serperKey'];
 console.log('web tools (search gating + fetch + execTool): OK');

 // ---- multi-paper comparison basket (Feature A) ----
 { const body2={}; const st2={ item:null, attachment:{id:7,key:'K2',libraryID:1}, blocks, doc, body:body2,
     status:stubEl(), chatMsgs:stubEl(), input:{value:''}, send:stubEl(),
     cmpBtn:stubEl(), multiBtn:stubEl(), basketBar:stubEl(), basket:[], multiMode:false, streaming:false, cancel:false };
   A._bodyState.set(body2, st2);
   // basket starts empty; the current paper is always folded into the list
   assert(A._basketList(st2).length===1 && A._basketList(st2)[0].key==='K2','_basketList folds in the current paper');
   // add a second paper (seed its blocks in the store so _basketBlocks finds them)
   A._blockStore.set('KB', blocks);
   st2.basket.push({ key:'KB', id:99, libraryID:1, title:'Paper B 对比篇' });
   assert(A._basketList(st2).length===2,'_basketList = basket + current (deduped)');
   // _basketToggle adds/removes the CURRENT paper
   A._basketToggle(st2);
   assert(st2.basket.some(p=>p.key==='K2'),'_basketToggle adds current paper');
   assert(/✓/.test(st2.cmpBtn.textContent),'_updateCmpBtn reflects added state');
   A._basketToggle(st2);
   assert(!st2.basket.some(p=>p.key==='K2'),'_basketToggle removes current paper');
   // _toggleMulti flips the mode flag + relabels
   A._toggleMulti(st2);
   assert(st2.multiMode===true && /开/.test(st2.multiBtn.textContent),'_toggleMulti turns cross-paper mode on');
   // multi context: labelled per-paper sections, colliding [B id] stripped to (p),
   // total within the maxChars budget
   const mctx=await A._buildMultiContext(st2,'vision encoder pretraining');
   assert(/【论文 1 · /.test(mctx) && /【论文 2 · /.test(mctx),'multi context labels each paper');
   assert(/Paper B 对比篇/.test(mctx),'multi context carries basket paper titles');
   assert(!/\[B\d+/.test(mctx) && /\(p/.test(mctx),'multi context strips colliding [B id], keeps (p页)');
   assert(mctx.length <= (Number(A.getPref('maxChars'))||60000),'multi context stays within maxChars budget');
   // onChatSend routes to the multi path only when mode is on AND ≥2 papers
   { const orig=A._send; let seen=null; A._send=async(s,t,o)=>{ seen=o; };
     st2.input.value='对比这两篇的方法';
     await A.onChatSend(body2);
     assert(seen && seen.multi===true,'onChatSend sets opts.multi when cross-paper mode on with ≥2 papers');
     st2.multiMode=false; st2.input.value='单篇问题';
     await A.onChatSend(body2);
     assert(seen && !seen.multi,'onChatSend stays single-paper when mode off');
     A._send=orig;
   }
   console.log('multi-paper comparison basket: OK');
 }

 // ---- conversation backup / multi-machine sync (Feature B) ----
 { // chat JSON <-> synced-note HTML round-trips, surviving HTML-special content
   const hist=[{role:'user',content:'对比 <b>A & B</b> 的方法 > 结果'},{role:'assistant',content:'见 [B5] 与 </pre> 边界'}];
   const noteHTML=A._chatDataToNote(hist);
   assert(/<pre[^>]*data-air-chat/.test(noteHTML),'synced note wraps JSON in <pre data-air-chat>');
   assert(!/<b>A & B<\/b>/.test(noteHTML),'HTML-special content is escaped inside the note');
   const back=A._parseChatDataNote(noteHTML);
   assert(back && back.messages.length===2 && back.messages[0].content===hist[0].content && back.messages[1].content===hist[1].content,'synced-note JSON round-trips losslessly');
   assert(typeof back.date==='string' && back.date.length>0,'synced bundle carries a date');
   assert(A._parseChatDataNote('<p>no data here</p>')===null,'_parseChatDataNote returns null when no payload');
   // _newerChat: date comparison picks the fresher side; ties keep local
   const older={date:'2026-01-01T00:00:00.000Z',messages:[{role:'user',content:'old'}]};
   const newer={date:'2026-02-01T00:00:00.000Z',messages:[{role:'user',content:'new'}]};
   assert(A._newerChat(older,newer).fromSync===true && A._newerChat(older,newer).bundle.messages[0].content==='new','_newerChat prefers the newer synced copy');
   assert(A._newerChat(newer,older).fromSync===false,'_newerChat keeps local when local is newer');
   assert(A._newerChat(older,null).bundle===older && !A._newerChat(older,null).fromSync,'_newerChat falls back to local when no synced copy');
   assert(A._newerChat(null,newer).fromSync===true,'_newerChat uses synced when no local copy');
   assert(A._newerChat(null,null).bundle===null,'_newerChat null-safe when neither exists');
   const tie={date:older.date,messages:[{role:'user',content:'tie'}]};
   assert(A._newerChat(older,tie).fromSync===false,'_newerChat keeps local on a date tie');
   console.log('conversation backup / sync (round-trip + newer-wins): OK');
 }

 // ---- share-material generator (一页总结 / 幻灯片 / HTML) ----
 { const fmts=A._shareFormats();
   assert(fmts.length===2 && fmts.map(f=>f.id).join(',')==='onepager,html','2 share formats registered (no slides)');
   assert(fmts.every(f=>f.label&&f.ext&&f.buildSystemPrompt('中文').length>40),'each share format has label/ext/prompt');
   assert(!fmts.find(f=>f.id==='slides'),'slides format removed');
   const htmlP=fmts.find(f=>f.id==='html').buildSystemPrompt('中文');
   assert(/HTML/.test(htmlP)&&/svg-wrap/.test(htmlP)&&/class=\"qa\"/.test(htmlP)&&/\[\[fig:/.test(htmlP),'html prompt uses the component system (svg-wrap/qa/fig)');
   // _embedFigures: placeholder → figure card; unresolved → dropped (no raw token)
   const emb=await A._embedFigures('见 [[fig:3]] 和 [[fig:9]]。', async(id)=> id===3?'data:image/png;base64,AAA':null);
   assert(/<div class="paper-fig"><img src="data:image\/png;base64,AAA"/.test(emb),'_embedFigures inserts a paper-fig card for resolved figures');
   assert(!/\[\[fig:9\]\]/.test(emb)&&!/\[\[fig:3\]\]/.test(emb),'_embedFigures leaves no raw fig tokens');
   const embThrow=await A._embedFigures('x [[fig:1]] y', async()=>{ throw new Error('no'); });
   assert(!/\[\[fig:1\]\]/.test(embThrow),'_embedFigures drops placeholder when resolver throws');
   // _svgFencesToInline
   const sv=A._svgFencesToInline("a\n```svg\n<svg viewBox='0 0 10 10'></svg>\n```\nb\n```js\nx=1\n```");
   assert(/<svg viewBox/.test(sv)&&!/```svg/.test(sv),'_svgFencesToInline inlines svg fences');
   assert(/```js/.test(sv),'_svgFencesToInline leaves non-svg fences alone');
   // _wrapHtmlDoc
   const doc2=A._wrapHtmlDoc('My Paper','<p>hi</p>');
   assert(/^<!doctype html/i.test(doc2),'_wrapHtmlDoc starts with doctype');
   assert(/<title>My Paper<\/title>/.test(doc2)&&/<style>/.test(doc2)&&/<p>hi<\/p>/.test(doc2),'_wrapHtmlDoc embeds title, style, body');
   assert(/&lt;script&gt;/.test(A._wrapHtmlDoc('<script>','x')),'_wrapHtmlDoc escapes the title');
   // section-by-section HTML pipeline
   assert(/JSON/.test(A._shareOutlinePrompt('中文')),'outline prompt asks for JSON');
   const ol=A._parseShareOutline('```json\n{"title":"T","tldr":"one","tags":["a","b"],"sections":[{"id":"s1","title":"背景","brief":"x"},{"id":"s2","title":"方法","brief":"y"}]}\n```');
   assert(ol&&ol.title==='T'&&ol.sections.length===2&&ol.sections[1].title==='方法','_parseShareOutline reads JSON (tolerates fence)');
   assert(A._parseShareOutline('not json')===null,'_parseShareOutline null on junk');
   assert(A._parseShareOutline('{"title":"x","sections":[]}')===null,'_parseShareOutline rejects empty sections');
   const secP=A._shareSectionPrompt('中文',{id:'s2',title:'方法',brief:'讲清楚'},'[[fig:3]] 图：arch');
   assert(/s2/.test(secP)&&/方法/.test(secP)&&/svg-wrap/.test(secP)&&/\[\[fig:/.test(secP),'section prompt carries id/title/components/figlist');
   assert(A._stripHtmlFence('```html\n<section>x</section>\n```')==='<section>x</section>','_stripHtmlFence unwraps fenced section');
   assert(/<header>/.test(A._shareHeaderHtml(ol))&&/class="tag"/.test(A._shareHeaderHtml(ol)),'_shareHeaderHtml renders header + tags');
   assert(/href="#s1"/.test(A._shareTocHtml(ol))&&/href="#s2"/.test(A._shareTocHtml(ol)),'_shareTocHtml links each section');
   const asm=A._assembleShareHtml(ol,['<section id="s1">A</section>','<section id="s2">B</section>']);
   assert(/<header>/.test(asm)&&/class="toc"/.test(asm)&&/id="s1"/.test(asm)&&/id="s2"/.test(asm)&&/<footer/.test(asm),'_assembleShareHtml joins header+toc+sections+footer');
   console.log('share-material generator (formats + embed + wrap + outline): OK');
 }

 // ---- full-text bilingual translation ----
 { const tblocks=[{id:0,type:'heading',text:'Title'},{id:1,type:'paragraph',text:'The model works well.'},{id:2,type:'heading',text:'Method'},{id:3,type:'paragraph',text:'We use a transformer.'},{id:4,type:'image',text:'fig'}];
   const units=A._translatableUnits(tblocks);
   assert(units.length===4 && units.every((u,i)=>u.n===i+1),'_translatableUnits numbers paragraphs+headings, skips image');
   assert(units.some(u=>u.heading),'headings flagged');
   const seg=A._numberSegments(units.slice(0,2));
   assert(/\[\[1\]\]/.test(seg)&&/\[\[2\]\]/.test(seg),'_numberSegments tags each unit');
   const tr=A._parseTranslations('好的：\n[[1]] 标题\n[[2]] 模型\n效果很好\n[[3]] 方法');
   assert(tr.get(1)==='标题'&&tr.get(3)==='方法'&&/模型/.test(tr.get(2))&&/效果很好/.test(tr.get(2)),'_parseTranslations maps n→译文 (multi-line safe)');
   const bi=A._interleaveBilingual('T',units,tr);
   assert(/# T（双语对照）/.test(bi)&&/> /.test(bi),'_interleaveBilingual adds title + blockquote translation');
   const bi2=A._interleaveBilingual('T',units,new Map());
   assert(bi2.includes(units[1].text)&&!/> /.test(bi2),'_interleaveBilingual falls back to original-only');
   const noteHTML=A._bilingualNoteHTML('T',units,tr);
   assert(/<h1>/.test(noteHTML)&&/<p>The model works well\.<\/p>/.test(noteHTML)&&/color:#1a73e8/.test(noteHTML),'_bilingualNoteHTML pairs original + colored translation');
   const batches=A._batchUnits(units,30);
   assert(batches.length>=2 && batches.reduce((n,b)=>n+b.length,0)===units.length,'_batchUnits splits by budget, keeps all');
   assert(/翻译/.test(A._buildTranslatePrompt('中文'))&&/\[\[n\]\]/.test(A._buildTranslatePrompt('中文')),'translate prompt states target + numbered format');
   console.log('full-text bilingual translation: OK');
 }

 // ---- layout safety net: assistant bubbles must constrain every descendant so
 // long URLs / English tool briefs / wide artifacts can't overflow the panel ----
 { const css=fs.readFileSync(path.join(__dirname,'..','content','style.css'),'utf8').replace(/\s+/g,' ');
   assert(/\.aireader-msg-assistant \.aireader-bubble \* \{[^}]*min-width: 0/.test(css),'bubble descendants pinned to min-width:0 (overflow safety net)');
   assert(/\.aireader-msg \{[^}]*min-width: 0/.test(css),'.aireader-msg has min-width:0');
   assert(/\.aireader-answer \{[^}]*overflow-wrap: anywhere/.test(css),'.aireader-answer wraps long tokens');
   assert(/\.aireader-rich[^{]*\{ white-space: normal/.test(css),'rich content stays white-space:normal (no mid-stream blank gaps)');
   // the structural overflow fix: assistant bubble has a DEFINITE width, the
   // scroller clips horizontally, code scrolls, and tables fit-and-wrap.
   assert(/\.aireader-msg-assistant \.aireader-bubble \{[^}]*width: 100%/.test(css),'assistant bubble has a definite width (so inner max-width:100% binds)');
   assert(/\.aireader-chat-msgs \{[^}]*overflow-x: hidden/.test(css),'scroller clips horizontally (panel can never widen)');
   assert(/\.aireader-bubble table \{[^}]*table-layout: fixed/.test(css),'tables are table-layout:fixed (fit + wrap, never overflow)');
   assert(/\.aireader-bubble pre[\s\S]{0,140}white-space: pre-wrap/.test(css),'code blocks wrap (never overflow the panel)');
   assert(/\.aireader-bubble \*[^}]*overflow-wrap: anywhere/.test(css),'general rule: every bubble descendant wraps long tokens');
   console.log('layout overflow safety net present: OK');
 }

 console.log('\nALL OK');
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
