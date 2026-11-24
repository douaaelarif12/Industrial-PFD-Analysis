import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, assetUrl } from './api'

type Member = { id: string; name: string; role: string }
type Project = {
  id: string; name: string; description: string; status: 'active'; created_at: string; updated_at: string;
  created_by_name: string; pfd_count: number; member_count: number; members: Member[];
  analysis_counts: {completed: number; running: number; failed: number}
}
type Pfd = {
  id: string; project_id: string; filename: string; uploaded_at: string; uploaded_by_name: string;
  status: string; analysis_id: string | null; last_analysis_at: string | null
}
type Job = { analysis_id: string; project_id: string; project_name: string; pfd_id: string; original_filename: string; status: string; message: string }
const steps = [['queued','En attente'],['rendering_pdf','Rendu du PDF'],['running_ocr','Lecture OCR'],['running_yolo','Détection YOLO'],['associating','Association des balises'],['completed','Terminé']]
const terminal = ['completed','failed','cancelled']
const statusLabels: Record<string,string> = {
  not_analyzed:'Non analysé', queued:'En attente', rendering_pdf:'Rendu PDF', running_ocr:'OCR en cours',
  running_yolo:'YOLO en cours', associating:'Association en cours', completed:'Terminée', failed:'Échec', cancelled:'Annulée'
}
const label = (status: string) => statusLabels[status] ?? status
const date = (value: string) => new Date(value).toLocaleDateString('fr-FR')
const dateTime = (value?: string | null) => value ? new Date(value).toLocaleString('fr-FR', {dateStyle:'short',timeStyle:'short'}) : '—'
const json = (payload: unknown, method = 'POST') => ({method, headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})

export function ProtectedAsset({path, image = false, frame = false, children}: {path: string; image?: boolean; frame?: boolean; children?: ReactNode}) {
  const container = useRef<HTMLDivElement>(null)
  const [url,setUrl] = useState(''); const [error,setError] = useState('')
  useEffect(() => {
    let objectUrl = ''; let active = true
    setUrl(''); setError('')
    fetch(assetUrl(path), {headers:{Authorization: 'Bearer ' + localStorage.getItem('pfd-access-token')}})
      .then(async r => {
        if(!r.ok) throw Error('Fichier indisponible ou accès refusé')
        if(frame) return new Blob([await r.text()], {type:'text/html;charset=utf-8'})
        return r.blob()
      })
      .then(blob => { if(active) { objectUrl=URL.createObjectURL(blob); setUrl(objectUrl) } }).catch(e => {if(active) setError(e.message)})
    return () => {active=false; if(objectUrl) URL.revokeObjectURL(objectUrl)}
  },[path,frame])
  if(error) return <span role="alert">{error}</span>
  if(!url) return <span>Chargement du fichier…</span>
  if(image) return <img src={url} alt="Page rendue du PFD" className="w-full border border-slate-200" style={{objectFit:'contain'}} />
  if(frame) return (
    <div ref={container} className="result-graph-frame">
      <iframe
        title="Graphe des équipements — PFD-230"
        src={url}
        sandbox="allow-scripts"
        style={{width:'100%',height:'480px',border:'none',display:'block',overflow:'hidden'}}
      />
    </div>
  )
  return <button type="button" onClick={()=>window.open(url,'_blank')} className="inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-[#073d92] hover:text-[#073d92]">{children || 'Ouvrir'}</button>
}

export function ValidatedGraph({graph}: {graph:{available:boolean;preview_html?:string;isolated_tags?:string[];equipment_nodes?:number;connections?:number;isolated_equipment?:number}}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [fsError, setFsError] = useState('')
  if(!graph.available) return <p className="rounded border bg-slate-50 p-4">Graphe non encore validé pour ce document.</p>
  const equipCount = graph.equipment_nodes ?? 16
  const relCount   = graph.connections ?? 8
  const isoCount   = graph.isolated_equipment ?? (graph.isolated_tags?.length ?? 6)
  return (
    <section className="min-w-0 overflow-hidden rounded-sm border border-slate-200 bg-white shadow-sm">
      {/* ── Card header ── */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
        <div>
          <div className="eyebrow">Connectivité validée</div>
          <h2 className="mt-1 text-xl font-semibold text-slate-900">Graphe des équipements — PFD-230</h2>
          <p className="mt-1.5 max-w-xl text-sm leading-6 text-slate-600">
            Ce graphe représente les relations inter-équipements validées pour le PFD-230.
            Les directions de procédé non confirmées restent volontairement inconnues.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 text-xs font-semibold">
          <span className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">{equipCount} équipements</span>
          <span className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-blue-700">{relCount} relations</span>
          <span className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-700">{isoCount} isolés</span>
        </div>
      </div>

      {/* ── Graph display ── */}
      <div className="w-full bg-slate-50 px-0" ref={containerRef}>
        {graph.preview_html ? (
          <ProtectedAsset path={graph.preview_html} frame />
        ) : graph.isolated_tags && (
          <div className="flex min-h-[320px] items-center justify-center p-8 text-sm text-slate-400">
            Aperçu du graphe indisponible pour ce document.
          </div>
        )}
      </div>

      {/* ── Actions bar ── */}
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 px-6 py-4">
        {graph.preview_html && (
          <ProtectedAsset path={graph.preview_html} frame={false}>
            <span className="inline-flex items-center gap-1.5">Ouvrir l'image du graphe</span>
          </ProtectedAsset>
        )}
        {containerRef && (
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded bg-[#073d92] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0a4dab]"
            onClick={async () => {
              try {
                if (document.fullscreenElement === containerRef.current) await document.exitFullscreen()
                else await containerRef.current?.requestFullscreen()
              } catch { setFsError('Le navigateur ne permet pas le plein écran.') }
            }}
          >
            Ouvrir le graphe en plein écran
          </button>
        )}
        {fsError && <span role="alert" className="text-sm text-red-700">{fsError}</span>}
      </div>

      {/* ── Isolated equipment list ── */}
      {graph.isolated_tags && graph.isolated_tags.length > 0 && (
        <div className="border-t border-slate-100 px-6 py-4">
          <h3 className="text-sm font-semibold text-slate-700">Équipements isolés</h3>
          <ul className="mt-3 flex flex-wrap gap-2">
            {graph.isolated_tags.map(tag => (
              <li key={tag} className="rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-600">{tag}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

export function ProjectWorkspace({path, navigate, renderResults}: {path: string; navigate:(path:string)=>void; renderResults:(data:any)=>ReactNode}) {
  const parts=path.split('/'); const pid=parts[1]; const fid=parts[3]; const aid=parts[5]; const mode=parts[4]
  const [projects,setProjects]=useState<Project[]>([]); const [current,setCurrent]=useState<Project|null>(null)
  const [documents,setDocuments]=useState<Pfd[]>([]); const [users,setUsers]=useState<Member[]>([]); const [admin,setAdmin]=useState(false)
  const [error,setError]=useState(''); const [busy,setBusy]=useState(false); const [search,setSearch]=useState('')
  const [editing,setEditing]=useState(false); const [name,setName]=useState(''); const [description,setDescription]=useState('')
  const [job,setJob]=useState<Job|null>(null); const [result,setResult]=useState<any>(null); const [tab,setTab]=useState('Résumé')
  const refresh = async () => {
    const [all,me]=await Promise.all([api<{items:Project[]}>('/api/projects'),api<{role:string}>('/api/auth/me')])
    setProjects(all.items); setAdmin(me.role==='admin')
    if(me.role==='admin') setUsers((await api<{items:Member[]}>('/api/users')).items)
    if(pid && pid!=='new') {
      const [p,d]=await Promise.all([api<Project>('/api/projects/'+pid),api<{items:Pfd[]}>('/api/projects/'+pid+'/pfds')])
      setCurrent(p); setDocuments(d.items)
    }
  }
  useEffect(() => {setCurrent(null); setJob(null); setResult(null); setError(''); setEditing(false); void refresh().catch(e=>setError(e.message))},[pid])
  useEffect(() => {
    if(!aid || !fid || !pid) return
    let active=true; let timer:number|undefined
    const poll=async()=>{
      try {
        const next=await api<Job>('/api/analyses/'+aid)
        if(next.project_id!==pid || next.pfd_id!==fid) throw Error('Cette analyse ne correspond pas au projet et au PFD demandés.')
        if(!active) return
        setJob(next)
        if(mode==='results') {
          if(next.status!=='completed') throw Error('Les résultats ne sont pas encore disponibles.')
          const data=await api<any>('/api/analyses/'+aid+'/results')
          if(active) setResult(data)
        } else if(!terminal.includes(next.status)) timer=window.setTimeout(poll,2000)
      } catch(e) {if(active) setError((e as Error).message)}
    }
    setJob(null); setResult(null); setError(''); void poll()
    return ()=>{active=false; if(timer) clearTimeout(timer)}
  },[pid,fid,aid,mode])
  const act=async(work:()=>Promise<void>)=>{setBusy(true);setError('');try{await work()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  const save=()=>act(async()=>{
    const saved=await api<Project>(editing?'/api/projects/'+pid:'/api/projects',json({name:name.trim(),description},editing?'PUT':'POST'))
    setEditing(false); await refresh(); navigate('projects/'+saved.id)
  })
  const upload=(files:FileList|null)=>act(async()=>{
    if(!pid || !files) return
    for(const file of Array.from(files)) {const form=new FormData();form.append('file',file);await api('/api/projects/'+pid+'/pfds',{method:'POST',body:form})}
    await refresh()
  })
  const analyze=(d:Pfd)=>act(async()=>{const j=await api<Job>('/api/pfds/'+d.id+'/analyze',{method:'POST'});navigate(`projects/${pid}/pfds/${d.id}/analysis/${j.analysis_id}`)})
  const button='rounded bg-[#073d92] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50'
  return <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
    {pid && <button onClick={()=>navigate(aid?'projects/'+pid:'projects')} className="text-blue-700">← {aid?'Retour au projet':'Tous les projets'}</button>}
    {error && <p role="alert" className="border border-red-200 bg-red-50 p-4 text-red-800">{error}</p>}
    {aid ? <>
      <div><p className="text-sm text-slate-500">{job?.project_name || current?.name}</p><h1 className="text-2xl font-bold">{job?.original_filename || 'Analyse du PFD'}</h1><p className="text-xs text-slate-500">{aid}</p></div>
      {job && mode==='analysis' && <section className="glass space-y-4 p-6"><h2 className="text-lg font-semibold">{label(job.status)}</h2><p role="status">{job.message}</p>
        {steps.map(([key,title],index)=><div key={key} className="flex justify-between border-b py-3"><span>{title}</span><span>{job.status==='completed'||index<steps.findIndex(s=>s[0]===job.status)?'Terminé':key===job.status?'En cours':'—'}</span></div>)}
        {job.status==='completed' && <button className={button} onClick={()=>navigate(`projects/${pid}/pfds/${fid}/results/${aid}`)}>Voir les résultats</button>}
        {['failed','cancelled'].includes(job.status) && <button disabled={busy} className={button} onClick={()=>void act(async()=>{const next=await api<Job>('/api/pfds/'+fid+'/analyze',{method:'POST'});navigate(`projects/${pid}/pfds/${fid}/analysis/${next.analysis_id}`)})}>{busy?'Préparation…':'Réessayer l’analyse'}</button>}
        {!terminal.includes(job.status) && <button className="text-red-700" onClick={()=>void act(async()=>{await api('/api/analyses/'+aid+'/cancel',{method:'POST'})})}>Arrêter l’analyse</button>}
      </section>}
      {result && mode==='results' && <><nav className="flex flex-wrap gap-3 border-b pb-3">{['Résumé','Aperçu','Textes OCR','Équipements','Associations','JSON','Graphe'].map(t=><button key={t} onClick={()=>setTab(t)} className={tab===t?'font-bold text-blue-700':'text-slate-500'}>{t}</button>)}</nav>
        {tab==='Résumé' && renderResults(result)}
        {tab==='Aperçu' && (result.artifacts.ocr_page?<ProtectedAsset path={result.artifacts.ocr_page} image/>:<p>Aperçu indisponible.</p>)}
        {['Textes OCR','Équipements','Associations','JSON'].includes(tab) && <pre className="max-h-[650px] overflow-auto rounded border bg-white p-4 text-xs">{JSON.stringify(tab==='Textes OCR'?result.ocr:tab==='Équipements'?result.detections:tab==='Associations'?result.associations:result,null,2)}</pre>}
        {tab==='Graphe' && <ValidatedGraph graph={result.validated_graph}/>}
      </>}
    </> : (pid==='new'||editing) ? <form className="glass max-w-2xl space-y-5 p-6" onSubmit={e=>{e.preventDefault();void save()}}>
      <h1 className="text-2xl font-bold">{editing?'Modifier le projet':'Nouveau projet'}</h1>
      {!admin?<p>La création des projets est réservée à l’administrateur.</p>:<><label className="block">Nom du projet<input required value={name} onChange={e=>setName(e.target.value)} className="mt-2 block w-full rounded border p-3"/></label><label className="block">Description<textarea value={description} onChange={e=>setDescription(e.target.value)} className="mt-2 block w-full rounded border p-3"/></label><button disabled={busy||!name.trim()} className={button}>Enregistrer</button></>}
    </form> : !pid ? <>
      <div className="flex items-center justify-between"><h1 className="text-3xl font-bold">Projets</h1>{admin&&<button className={button} onClick={()=>{setName('');setDescription('');navigate('projects/new')}}>+ Créer un projet</button>}</div>
      <input aria-label="Rechercher un projet" placeholder="Rechercher un projet…" value={search} onChange={e=>setSearch(e.target.value)} className="w-full max-w-md rounded border p-3"/>
      <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">{projects.filter(p=>p.name.toLowerCase().includes(search.toLowerCase())).map(p=><button key={p.id} onClick={()=>navigate('projects/'+p.id)} className="glass overflow-hidden rounded-lg text-left"><div className="project-cover"><span className="project-cover-count">{p.pfd_count} PFD</span></div><div className="space-y-3 p-5"><h2 className="text-xl font-bold">{p.name}</h2><p className="text-sm text-slate-500">{p.description}</p><p className="text-xs text-slate-500">Créé le {date(p.created_at)} · {p.members.length} membres</p><p className="text-blue-700">Ouvrir →</p></div></button>)}</div>
      {!projects.length&&!error&&<p>Aucun projet affecté. Contactez votre administrateur.</p>}
    </> : current && <>
      <section className="glass overflow-hidden">
        <div className="border-b border-slate-200 px-6 py-5 sm:px-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="eyebrow">Informations du projet</p>
              <h1 className="mt-2 break-words text-3xl font-bold text-slate-900">{current.name}</h1>
              <p className="mt-3 max-w-3xl leading-7 text-slate-600">{current.description || 'Aucune description renseignée.'}</p>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-700">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />{current.status === 'active' ? 'Actif' : 'Inactif'}
            </span>
          </div>
          <dl className="mt-6 grid gap-4 border-t border-slate-100 pt-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-slate-500">Créé le</dt><dd className="mt-1 font-semibold text-slate-800">{dateTime(current.created_at)}</dd></div>
            <div><dt className="text-slate-500">Dernière modification</dt><dd className="mt-1 font-semibold text-slate-800">{dateTime(current.updated_at)}</dd></div>
            <div><dt className="text-slate-500">Créateur du projet</dt><dd className="mt-1 font-semibold text-slate-800">{current.created_by_name}</dd></div>
            <div><dt className="text-slate-500">Membres affectés</dt><dd className="mt-1 font-semibold text-slate-800">{current.member_count}</dd></div>
          </dl>
        </div>
        <div className="grid gap-3 bg-slate-50 p-4 sm:grid-cols-2 sm:p-6 lg:grid-cols-4 xl:grid-cols-5">
          {[
            ['PFD',current.pfd_count,'border-[#073d92]'],
            ['Analyses terminées',current.analysis_counts.completed,'border-emerald-500'],
            ['Analyses en cours',current.analysis_counts.running,'border-amber-500'],
            ['Analyses en échec',current.analysis_counts.failed,'border-red-500'],
            ['Membres',current.member_count,'border-sky-500']
          ].map(([title,value,color])=><div key={String(title)} className={`border-l-4 ${color} bg-white p-4 shadow-sm`}><p className="text-2xl font-bold text-slate-900">{value}</p><p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p></div>)}
        </div>
      </section>
      {admin&&<section className="glass space-y-3 p-4"><div className="flex gap-4"><button onClick={()=>{setName(current.name);setDescription(current.description);setEditing(true)}}>Modifier le projet</button><button className="text-red-700" onClick={()=>{if(window.confirm('Supprimer ce projet ? Les projets contenant des PFD sont protégés.')) void act(async()=>{await api('/api/projects/'+pid,{method:'DELETE'});navigate('projects')})}}>Supprimer le projet</button></div><h2 className="font-semibold">Affectation des utilisateurs</h2>{users.filter(u=>u.role==='user').map(u=><label key={u.id} className="mr-5 inline-flex gap-2"><input type="checkbox" disabled={busy} checked={current.members.some(m=>m.id===u.id)} onChange={e=>{const checked=e.target.checked;void act(async()=>{await api(`/api/projects/${pid}/users/${u.id}`,{method:checked?'POST':'DELETE'});await refresh()})}}/>{u.name}</label>)}</section>}
      <section className="glass space-y-5 p-6"><h2 className="text-xl font-bold">PFD du projet</h2><label onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(!busy) void upload(e.dataTransfer.files)}} className="block cursor-pointer rounded border-2 border-dashed border-blue-200 bg-blue-50 p-8 text-center">{busy?'Opération en cours…':'+ Téléverser un PFD — glissez vos PDF ici ou cliquez pour parcourir'}<input disabled={busy} type="file" multiple accept="application/pdf" className="mt-4 block w-full text-sm" onChange={e=>{void upload(e.target.files);e.target.value=''}}/></label>
        <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr>{['Fichier','Ajouté le','Téléversé par','Statut analyse','Dernière analyse','Actions'].map(t=><th key={t} className="whitespace-nowrap p-3">{t}</th>)}</tr></thead><tbody>{documents.map(d=><tr key={d.id} className="tbl-row border-t"><td className="max-w-[260px] break-words p-3 font-semibold text-slate-800">{d.filename}</td><td className="whitespace-nowrap p-3">{dateTime(d.uploaded_at)}</td><td className="p-3">{d.uploaded_by_name}</td><td className="p-3"><span className="inline-flex whitespace-nowrap rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700">{label(d.status)}</span></td><td className="whitespace-nowrap p-3">{dateTime(d.last_analysis_at)}</td><td className="p-3">{d.analysis_id?<button className="font-semibold text-blue-700" onClick={()=>navigate(`projects/${pid}/pfds/${d.id}/${d.status==='completed'?'results':'analysis'}/${d.analysis_id}`)}>{d.status==='completed'?'Voir résultats':'Voir analyse'}</button>:<button disabled={busy} className={button} onClick={()=>void analyze(d)}>Analyser</button>}</td></tr>)}</tbody></table></div>
      </section>
    </>}
  </div>
}
