import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowDown, ArrowUp, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, FileText, FolderOpen, Menu, MessageSquare, Mic, MoreHorizontal, Paperclip, Plus, Search, Settings2, Sparkles, SquarePen, Sun, WandSparkles, X } from 'lucide-react'
import VoiceMode from './VoiceMode.jsx'

const API = '/api'
const starter = [
  { icon: Sparkles, title: 'Get clarity', prompt: 'Help me think through a decision I’m facing' },
  { icon: FileText, title: 'Understand a document', prompt: 'Can you help me summarize and understand a document?' },
  { icon: WandSparkles, title: 'Make a plan', prompt: 'Help me make a simple plan for my week' },
]
const initialMessages = []

async function readApiResponse(response) {
  const body = await response.text()
  let data
  try { data = body ? JSON.parse(body) : null }
  catch { throw new Error(`The API returned an invalid response (HTTP ${response.status}). Check the backend terminal.`) }
  if (!response.ok) throw new Error(data?.detail || `The API request failed (HTTP ${response.status}).`)
  if (data == null) throw new Error(`The API returned an empty response (HTTP ${response.status}). Check the backend terminal.`)
  return data
}

function App() {
  const desktopVoice = new URLSearchParams(window.location.search).get('desktop') === 'voice'
  return desktopVoice ? <div className="desktop-voice-shell"><VoiceMode desktopMode /></div> : <WorkspaceApp />
}

function WorkspaceApp() {
  const [chats, setChats] = useState([]), [chatId, setChatId] = useState(null), [messages, setMessages] = useState(initialMessages)
  const [input, setInput] = useState(''), [busy, setBusy] = useState(false), [section, setSection] = useState('Chat')
  const [sidebar, setSidebar] = useState(true), [menuOpen, setMenuOpen] = useState(false), [toast, setToast] = useState('')
  const [memory, setMemory] = useState([]), [creator, setCreator] = useState(null), [tasks, setTasks] = useState([]), [documents, setDocuments] = useState([]), [apiReady, setApiReady] = useState(false)
  const [query, setQuery] = useState(''), [modal, setModal] = useState(''), [draft, setDraft] = useState(''), [editingMemoryId, setEditingMemoryId] = useState(null)
  const endRef = useRef(null), fileRef = useRef(null), inputRef = useRef(null)

  useEffect(() => { refresh(); fetch(`${API}/health`).then(r => r.json()).then(d => setApiReady(d.groq_configured)).catch(() => setApiReady(false)) }, [])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, busy])
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 2700); return () => clearTimeout(t) } }, [toast])
  async function refresh() {
    try { const [c, m, t, d, owner] = await Promise.all(['chats','memories','tasks','documents','creator'].map(x => fetch(`${API}/${x}`).then(r => r.json())))
      setChats(c); setMemory(m); setTasks(t); setDocuments(d); setCreator(owner)
    } catch { /* The UI remains usable while the API is offline. */ }
  }
  function newChat() { setChatId(null); setMessages([]); setSection('Chat'); setTimeout(() => inputRef.current?.focus(), 50) }
  async function openChat(id) {
    setSection('Chat')
    try { const data = await fetch(`${API}/chats/${id}`).then(r => r.json()); setChatId(id); setMessages(data.messages || []) }
    catch { setToast('Could not open this conversation. Start the API to load history.') }
  }
  async function send(text = input) {
    const content = text.trim(); if (!content || busy) return
    setInput(''); setSection('Chat'); setBusy(true)
    const userMessage = { role: 'user', content }
    setMessages(old => [...old, userMessage])
    try {
      const response = await fetch(`${API}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_id: chatId, message: content }) })
      const data = await readApiResponse(response)
      if (data.conversation_id) setChatId(data.conversation_id)
      setMessages(old => [...old, { role: 'assistant', content: data.reply }]); refresh()
    } catch (e) {
      setMessages(old => [...old, { role: 'assistant', content: `I couldn’t reach the Arisa API. ${e.message === 'Failed to fetch' ? 'Start the FastAPI server and add your Groq key to backend/.env to get a reply.' : e.message}` }])
    } finally { setBusy(false) }
  }
  async function upload(file) {
    if (!file) return
    const body = new FormData(); body.append('file', file)
    try { const r = await fetch(`${API}/documents`, { method: 'POST', body }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setToast(`${file.name} is ready to explore`); refresh() }
    catch (e) { setToast(e.message || 'Upload failed. Is the API running?') }
    if (fileRef.current) fileRef.current.value = ''
  }
  async function addItem(kind) {
    const value = draft.trim(); if (!value) return
    try {
      const editing = kind === 'memories' && editingMemoryId
      const r = await fetch(`${API}/${kind}${editing ? `/${editingMemoryId}` : ''}`, { method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(kind === 'tasks' ? { title: value } : { content: value }) })
      if (!r.ok) throw new Error(); setDraft(''); setModal(''); setEditingMemoryId(null); refresh(); setToast(kind === 'tasks' ? 'Task added' : editing ? 'Memory updated' : 'Memory saved')
    } catch { setToast('Start the Arisa API to save this.') }
  }
  function editMemory(item) { setDraft(item.content); setEditingMemoryId(item.id); setModal('memory') }
  async function remove(kind, id) { await fetch(`${API}/${kind}/${id}`, { method: 'DELETE' }).catch(() => {}); refresh() }
  async function completeTask(task) { await fetch(`${API}/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed: !task.completed }) }).catch(() => {}); refresh() }
  async function deleteChat(id) { await fetch(`${API}/chats/${id}`, { method: 'DELETE' }).catch(() => {}); setChats(c => c.filter(x => x.id !== id)); if (chatId === id) newChat() }
  const filtered = chats.filter(c => c.title?.toLowerCase().includes(query.toLowerCase()))
  return <div className="app-shell">
    {sidebar && <aside className="sidebar">
      <div className="brand-row"><button className="brand" onClick={newChat}><span className="brand-mark"><Sparkles size={16}/></span><span>Arisa<span className="brand-ai">AI</span></span></button><button className="icon-button collapse" aria-label="Close sidebar" onClick={() => setSidebar(false)}><ChevronLeft size={18}/></button></div>
      <button className="new-chat" onClick={newChat}><SquarePen size={16}/><span>New conversation</span><span className="shortcut">⌘ K</span></button>
      <div className="nav-group"><div className="nav-label">YOUR SPACE</div>
        <Nav icon={MessageSquare} label="Chat" active={section === 'Chat'} onClick={() => setSection('Chat')}/>
        <Nav icon={Mic} label="Voice" active={section === 'Voice'} onClick={() => setSection('Voice')}/>
        <Nav icon={FolderOpen} label="Documents" count={documents.length} active={section === 'Documents'} onClick={() => setSection('Documents')}/>
        <Nav icon={Check} label="Tasks" count={tasks.filter(t => !t.completed).length} active={section === 'Tasks'} onClick={() => setSection('Tasks')}/>
        <Nav icon={BookOpen} label="Memory" active={section === 'Memory'} onClick={() => setSection('Memory')}/>
      </div>
      <div className="history-head"><span className="nav-label">RECENT</span><button className="icon-button tiny" aria-label="Search chats" onClick={() => document.querySelector('.history-search')?.focus()}><Search size={15}/></button></div>
      <input className="history-search" placeholder="Search conversations" value={query} onChange={e => setQuery(e.target.value)}/>
      <div className="chat-list">{filtered.map(c => <div key={c.id} className={`chat-row ${chatId === c.id ? 'selected' : ''}`}><button onClick={() => openChat(c.id)} title={c.title}><MessageSquare size={14}/><span>{c.title}</span></button><button className="chat-delete" aria-label="Delete conversation" onClick={() => deleteChat(c.id)}><X size={13}/></button></div>)}{!filtered.length && <div className="empty-history">{chats.length ? 'No matching conversations' : 'Your conversations will appear here'}</div>}</div>
      <div className="sidebar-bottom"><button className="profile" onClick={() => setSection('Settings')}><div className="avatar">K</div><div className="profile-copy"><strong>Ken</strong><span>Arisa’s creator · personal profile</span></div><MoreHorizontal size={18}/></button></div>
    </aside>}
    <main className="main-area">
      <header className="topbar">{!sidebar && <button className="icon-button" onClick={() => setSidebar(true)}><Menu size={18}/></button>}<div className="breadcrumb"><span>{section === 'Chat' ? 'Workspace' : 'Your space'}</span><ChevronRight size={14}/><strong>{section}</strong></div><div className="top-actions"><div className={`connection ${apiReady ? 'connected' : ''}`}><span className="status-dot"/>{apiReady ? 'AI ready' : 'Setup needed'}</div><button className="icon-button help-button" aria-label="Setup help" onClick={() => setModal('help')}><CircleHelp size={18}/></button></div></header>
      {section === 'Voice' ? <VoiceMode onSwitchToText={() => { setSection('Chat'); setTimeout(() => inputRef.current?.focus(), 50) }} /> : section === 'Chat' ? <>
        {messages.length === 0 ? <div className="welcome-wrap"><div className="welcome-content"><div className="welcome-icon"><span className="orbit orbit-one"/><span className="orbit orbit-two"/><Sparkles size={23}/></div><div className="eyebrow"><span className="eyebrow-line"/> YOUR THOUGHTFUL AI SPACE <span className="eyebrow-line"/></div><h1>A little more <span>clarity.</span><br/>A lot more <span>you.</span></h1><p className="welcome-sub">A place to think things through, make sense of the details,<br className="desktop-only"/> and find your next step.</p><div className="suggestion-grid">{starter.map(({icon: Icon,title,prompt})=><button key={title} className="suggestion" onClick={() => send(prompt)}><div className="suggestion-icon"><Icon size={17}/></div><div className="suggestion-copy"><strong>{title}</strong><span>{prompt}</span></div><ArrowUpRight size={15} className="suggestion-arrow"/></button>)}</div><div className="quiet-note"><span className="quiet-dot"/> Your conversations are yours. Start anywhere.</div></div><div className="welcome-orb orb-bg-one"/><div className="welcome-orb orb-bg-two"/></div> : <div className="conversation"><div className="messages">{messages.map((m,i)=><Message key={`${i}-${m.role}`} message={m} />)}{busy && <div className="assistant-row"><div className="assistant-avatar"><Sparkles size={14}/></div><div className="typing"><i/><i/><i/></div></div>}<div ref={endRef}/></div></div>}
        <div className={`composer-area ${messages.length ? 'composer-bottom' : ''}`}><div className="composer"><textarea ref={inputRef} rows={1} value={input} placeholder="Ask anything, or just start thinking out loud…" onChange={e => { setInput(e.target.value); e.target.style.height='auto'; e.target.style.height=`${Math.min(e.target.scrollHeight,144)}px` }} onKeyDown={e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()} }} /><div className="composer-toolbar"><div className="composer-tools"><button className="tool-button" onClick={() => fileRef.current?.click()}><Paperclip size={16}/><span>Attach a file</span></button><input ref={fileRef} type="file" accept=".pdf,.txt,.md" hidden onChange={e => upload(e.target.files?.[0])}/><button className="tool-button model-button" onClick={() => setToast('Model selection is managed in backend settings')}><Sparkles size={14}/><span>Arisa · Groq</span><ChevronDown size={13}/></button></div><button className={`send-button ${input.trim() ? 'ready' : ''}`} onClick={() => send()} disabled={!input.trim() || busy} aria-label="Send message"><ArrowUp size={17}/></button></div></div><div className="composer-footnote">Arisa can make mistakes. Take a moment to check important details.</div></div>
      </> : <SectionPage section={section} memory={memory} creator={creator} tasks={tasks} documents={documents} onAdd={() => { setModal(section === 'Tasks' ? 'task' : 'memory'); setDraft(''); setEditingMemoryId(null) }} onEditMemory={editMemory} onUpload={() => fileRef.current?.click()} onFile={upload} fileRef={fileRef} onRemove={remove} onComplete={completeTask} onSend={p => { setInput(p); setSection('Chat'); setTimeout(() => send(p), 30) }} />}
      <div className="toast" role="status" data-visible={!!toast}>{toast}</div>
    </main>
    {modal && <div className="modal-scrim" onMouseDown={e => e.target === e.currentTarget && setModal('')}><div className="modal"><button className="modal-close" onClick={() => setModal('')}><X size={17}/></button>{modal === 'help' ? <><div className="modal-symbol"><Sparkles size={18}/></div><h2>Make Arisa yours</h2><p>Start the API and add your Groq key to connect an AI model. Your chat history, memories, tasks, and documents are stored locally in SQLite.</p><div className="setup-code"><span>Terminal</span><code>cd backend · pip install -r requirements.txt<br/>uvicorn main:app --reload</code></div><div className="setup-code"><span>backend/.env</span><code>GROQ_API_KEY=your_key_here</code></div><button className="primary-button modal-action" onClick={() => setModal('')}>Got it <ArrowUpRight size={15}/></button></> : <><div className="modal-symbol">{modal === 'task' ? <Check size={18}/> : <BookOpen size={18}/>}</div><h2>{modal === 'task' ? 'A small next step' : editingMemoryId ? 'Update saved memory' : 'Keep this in mind'}</h2><p>{modal === 'task' ? 'Add a task you’d like to come back to.' : editingMemoryId ? 'Update the detail Arisa has saved for future conversations.' : 'Save a detail you want Arisa to remember.'}</p><textarea autoFocus className="modal-input" value={draft} onChange={e => setDraft(e.target.value)} placeholder={modal === 'task' ? 'What needs doing?' : 'What would you like Arisa to remember?'} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && addItem(modal === 'task' ? 'tasks' : 'memories')}/><button className="primary-button modal-action" onClick={() => addItem(modal === 'task' ? 'tasks' : 'memories')}>{editingMemoryId ? 'Save changes' : `Save ${modal === 'task' ? 'task' : 'memory'}`} <ArrowUpRight size={15}/></button></>}</div></div>}
  </div>
}

function Nav({icon:Icon,label,count,active,onClick}) { return <button className={`nav-item ${active?'active':''}`} onClick={onClick}><Icon size={16}/><span>{label}</span>{count > 0 && <span className="nav-count">{count}</span>}</button> }
function Message({message}) { const isUser=message.role==='user'; return <div className={`message-row ${isUser?'user-row':'assistant-row'}`}>{!isUser&&<div className="assistant-avatar"><Sparkles size={14}/></div>}<div className={`message-bubble ${isUser?'user-bubble':'assistant-bubble'}`}>{message.content.split('\n').map((line,i)=><p key={i}>{line || <br/>}</p>)}{!isUser&&<div className="message-actions"><button title="Copy response" onClick={() => navigator.clipboard?.writeText(message.content)}><FileText size={13}/></button><button title="Continue thinking" onClick={() => document.querySelector('textarea')?.focus()}><ArrowDown size={13}/></button></div>}</div></div> }
function SectionPage({section,memory,creator,tasks,documents,onAdd,onEditMemory,onUpload,onFile,fileRef,onRemove,onComplete,onSend}) {
 const configs={Documents:{icon:FolderOpen,title:'Your documents',desc:'Bring in a file. We’ll make it easier to find what matters.',items:documents,empty:'No documents yet',hint:'PDF, TXT, and Markdown · up to 10 MB'},Tasks:{icon:Check,title:'A little more momentum',desc:'Keep track of the things you want to get done.',items:tasks,empty:'Nothing on your list yet',hint:'One small step counts.'},Memory:{icon:BookOpen,title:'What Arisa remembers',desc:'Your saved details are editable. Arisa’s creator identity is stored separately and protected.',items:memory,empty:'No personal memories saved yet',hint:'Save a detail that you explicitly want Arisa to remember.'}}
 if(section==='Settings')return <div className="page-wrap"><div className="page-heading"><div className="page-kicker">PREFERENCES</div><h1>Your settings</h1><p>Shape how Arisa feels and works for you.</p></div><div className="settings-card"><div className="settings-icon"><Sparkles size={17}/></div><div><strong>Assistant name</strong><p>Arisa AI</p></div><span className="settings-value">Personal assistant</span></div><div className="settings-card"><div className="settings-icon"><Activity size={17}/></div><div><strong>AI connection</strong><p>Groq API, configured on your backend</p></div><span className="settings-value">Managed in .env</span></div><div className="settings-card"><div className="settings-icon"><Sun size={17}/></div><div><strong>Appearance</strong><p>A calm dark workspace</p></div><span className="settings-value">Dark</span></div></div>
 const cfg=configs[section]; if(!cfg)return null; const Icon=cfg.icon
 return <div className="page-wrap"><div className="page-heading"><div className="page-kicker">YOUR SPACE / {section.toUpperCase()}</div><div className="page-title-row"><div><h1>{cfg.title}</h1><p>{cfg.desc}</p></div>{section==='Documents'?<><button className="primary-button" onClick={onUpload}><Plus size={16}/> Add document</button><input ref={fileRef} type="file" accept=".pdf,.txt,.md" hidden onChange={e=>onFile(e.target.files?.[0])}/></>:<button className="primary-button" onClick={onAdd}><Plus size={16}/> {section==='Tasks'?'Add a task':'Add memory'}</button>}</div></div>
 {section==='Documents'&&documents.length>0&&<div className="document-ask"><div className="doc-ask-icon"><Sparkles size={16}/></div><div><strong>Ask across your documents</strong><span>Summaries, details, or a question you can’t quite answer.</span></div><button onClick={()=>onSend('Help me explore my uploaded documents.')}><ArrowUpRight size={16}/></button></div>}
 {section==='Memory'&&creator&&<div className="creator-memory-card"><div className="creator-memory-icon"><BookOpen size={17}/></div><div className="creator-memory-copy"><strong>{creator.name} · Arisa’s creator and only user</strong><span>{creator.role}</span><p>{creator.details}</p><small>Protected identity · stored separately from personal memories</small></div></div>}
 {!cfg.items.length?<div className="empty-card"><div className="empty-illustration"><span className="empty-glow"/><Icon size={22}/></div><h3>{cfg.empty}</h3><p>{cfg.hint}</p></div>:<div className="item-list">{cfg.items.map(item=><div className="data-card" key={item.id}><div className="data-icon"><Icon size={17}/></div><div className="data-copy"><strong>{item.title||item.filename||item.content}</strong><span>{section==='Tasks'?(item.completed?'Completed':'To do'):section==='Documents'?`${item.chunks||0} characters · ${item.created_at?.slice(0,10)||'Added recently'}`:`Saved ${item.created_at?.slice(0,10)||'recently'}`}</span></div>{section==='Tasks'&&<button className={`check-task ${item.completed?'done':''}`} onClick={()=>onComplete(item)} aria-label="Toggle task"><Check size={15}/></button>}{section==='Memory'&&<button className="edit-memory" onClick={()=>onEditMemory(item)} aria-label="Edit saved memory">Edit</button>}<button className="remove-item" onClick={()=>onRemove(section==='Tasks'?'tasks':section==='Documents'?'documents':'memories',item.id)} aria-label="Delete"><X size={15}/></button></div>)}</div>}
 </div>
}

export default App

