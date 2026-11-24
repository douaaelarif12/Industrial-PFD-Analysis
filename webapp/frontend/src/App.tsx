import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Variants } from 'framer-motion'
import {
  Background, Controls, Handle, MiniMap, Position,
  ReactFlow, ReactFlowProvider,
  type Edge, type Node, useReactFlow,
} from '@xyflow/react'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp,
  CheckCircle2, ChevronRight, Copy, Download,
  FileUp, Menu, Search, X, AlertTriangle, Clock,
  Loader2, CheckCheck, XCircle, Zap,
  LogOut, Home as HomeIcon, Folder, Settings, UserRound, Plus, FileText, CheckCircle2 as CheckCircle,
} from 'lucide-react'
import { api, assetUrl } from './api'
import { ProjectWorkspace, ProtectedAsset } from './ProjectWorkspace'
import { UserManagement } from './UserManagement'
type LocalUser = { id: string; name: string; email: string; role: 'admin' | 'user'; active: boolean; created_at: string }
import type { Connection, Equipment, FlowArrow, Graph, Summary } from './types'

/* ─── ROUTING ────────────────────────────────────────────────────────────── */
type Route = 'home' | 'projects' | 'users' | 'settings' | 'analysis' | 'upload' | 'equipment' | 'connectivity' | 'arrows' | 'graph' | 'json'
const routes: Route[] = ['home', 'projects', 'users', 'settings', 'analysis', 'upload', 'equipment', 'connectivity', 'arrows', 'graph', 'json']
const nav: Array<[Route, string]> = [['home', 'Accueil'], ['projects', 'Projets'], ['settings', 'Paramètres']]
const currentPath = () => (location.hash ? location.hash.slice(1) : location.pathname).replace(/^\/+/, '') || 'home'
function navigateWorkspace(path: string) { history.pushState(null, '', '/' + path); window.dispatchEvent(new PopStateEvent('popstate')) }

/* ─── CONSTANTS ──────────────────────────────────────────────────────────── */
const classColors: Record<string, string> = {
  pump: '#397ee3', pump_box: '#e88928', cyclone_cluster: '#c54839',
  sampler: '#9a4cb5', tank: '#2273c9', process_cell: '#06939f',
}
const format = (v: number, d = 0) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }).format(v)

/* ─── JOB STATUS STEPS ───────────────────────────────────────────────────── */
const JOB_STEPS: Array<{ id: string; label: string }> = [
  { id: 'queued',        label: 'En attente' },
  { id: 'rendering_pdf', label: 'Rendu du PDF' },
  { id: 'running_ocr',   label: 'Lecture OCR' },
  { id: 'running_yolo',  label: 'Détection YOLO' },
  { id: 'associating',   label: 'Association des balises' },
  { id: 'completed',     label: 'Terminé' },
]
const JOB_MESSAGES: Record<string, string> = {
  queued: 'Analyse placée en attente.',
  rendering_pdf: 'Rendu du PDF en cours.',
  running_ocr: 'Lecture des textes par OCR en cours.',
  running_yolo: 'Détection des équipements par YOLO en cours.',
  associating: 'Association des balises OCR aux équipements en cours.',
  completed: 'Analyse terminée : les résultats sont disponibles.',
  cancelled: 'Analyse annulée à la fermeture de l’application.',
}
const jobMessage = (job: { analysis_id: string; status: string; message: string }) => {
  // The backend publishes detailed, live progress (OCR tiles and ETA).  Keep
  // that information instead of replacing it with a generic status sentence.
  const detail = job.message?.trim() || JOB_MESSAGES[job.status] || 'Analyse en cours.'
  return `${detail} Analyse : ${job.analysis_id} (${job.status}).`
}

/* ─── ANIMATION VARIANTS ─────────────────────────────────────────────────── */
const EASE_SPRING: [number, number, number, number] = [0.22, 0.68, 0, 1.1]
const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: (i = 0) => ({ opacity: 1, y: 0, transition: { delay: i * 0.08, duration: 0.45, ease: EASE_SPRING } }),
}
const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.07 } },
}

/* ─── DATA HOOK ──────────────────────────────────────────────────────────── */
function useDemoData(enabled: boolean) {
  const [summary, setSummary]         = useState<Summary | null>(null)
  const [equipment, setEquipment]     = useState<Equipment[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [arrows, setArrows]           = useState<FlowArrow[]>([])
  const [graph, setGraph]             = useState<Graph | null>(null)
  const [raw, setRaw]                 = useState<unknown>(null)
  const [error, setError]             = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    Promise.all([
      api<Summary>('/api/demo/summary'),
      api<{ items: Equipment[] }>('/api/demo/equipment'),
      api<{ items: Connection[] }>('/api/demo/connections'),
      api<{ items: FlowArrow[] }>('/api/demo/arrows'),
      api<Graph>('/api/demo/graph'),
      api<unknown>('/api/demo/json'),
    ]).then(([s, e, c, a, g, j]) => {
      setSummary(s); setEquipment(e.items); setConnections(c.items)
      setArrows(a.items); setGraph(g); setRaw(j)
    }).catch((reason: Error) => setError(`Demo API unavailable: ${reason.message}`))
  }, [enabled])
  return { summary, equipment, connections, arrows, graph, raw, error }
}

function useAuth() {
  const [session, setSession] = useState<LocalUser | null>(null)
  const [ready, setReady] = useState(false)
  const refresh = () => api<LocalUser>('/api/auth/me').then(setSession).catch(() => setSession(null)).finally(() => setReady(true))
  useEffect(() => {
    refresh(); const listener = () => refresh(); window.addEventListener('pfd-auth-changed', listener)
    return () => window.removeEventListener('pfd-auth-changed', listener)
  }, [])
  return { session, ready }
}

/* ─── APP ROOT ───────────────────────────────────────────────────────────── */
function App() {
  const { session, ready } = useAuth()
  const [route, setRoute]         = useState<Route>(() => currentPath().split('/')[0] as Route)
  const [resourcePath, setResourcePath] = useState(currentPath)
  const [mobileOpen, setMobileOpen] = useState(false)
  const isDemoRoute = false
  useEffect(() => {
    const listener = () => {
      const path = currentPath(); const r = path.split('/')[0] as Route
      setResourcePath(path); setRoute(r)
    }
    addEventListener('hashchange', listener)
    addEventListener('popstate', listener)
    return () => {removeEventListener('hashchange', listener);removeEventListener('popstate', listener)}
  }, [])
  const go = (next: Route) => {
    navigateWorkspace(next); setMobileOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const content = route === 'home'
    ? <Home go={go} userName={session?.name} role={session?.role} />
    : route === 'projects'
      ? <ProjectWorkspace key={resourcePath} path={resourcePath} navigate={navigateWorkspace} renderResults={result=><GenericResultPanel result={result}/>} />
      : route === 'users'
        ? session?.role === 'admin' ? <UserManagement /> : <ErrorState error="Accès réservé à l’administrateur." />
      : route === 'settings'
        ? <SettingsPage user={session!} />
      : <div className="p-8"><p>Ouvrez un projet puis un PFD pour accéder à ses analyses.</p><button onClick={()=>go('projects')}>Voir mes projets</button></div>
  if (!ready) return <Loading />
  if (!session) return <LoginPage />
  return (
    <div className="jesa-app min-h-screen overflow-x-hidden bg-[#f3f5f7] text-[#142b4f]">
      <Sidebar route={route} go={go} user={session!} onSignOut={() => { localStorage.removeItem('pfd-access-token'); window.dispatchEvent(new Event('pfd-auth-changed')) }} />
      <div className="app-shell-main"><Header route={route} go={go} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen}
        userEmail={session.email || 'Utilisateur'} onSignOut={() => { localStorage.removeItem('pfd-access-token'); window.dispatchEvent(new Event('pfd-auth-changed')) }} />
      <main>{content}</main>
      <Footer demo={isDemoRoute} />
      </div>
    </div>
  )
}

function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage(null)
    try {
      const result = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,password}) })
      const data = await result.json()
      if (!result.ok) { setMessage(data.detail || 'E-mail ou mot de passe incorrect'); return }
      localStorage.setItem('pfd-access-token', data.access_token)
      window.dispatchEvent(new Event('pfd-auth-changed'))
    } catch {
      setMessage('Le serveur de connexion est indisponible. Réessayez dans quelques instants.')
    } finally {
      setBusy(false)
    }
  }
  return <div className="min-h-screen bg-[#f3f5f7] px-5 py-16 text-[#142b4f]">
    <div className="mx-auto max-w-md border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/60">
      <img src="/jesa-logo.png" alt="JESA" className="h-10 w-auto" />
      <div className="eyebrow mt-8">PFD Intelligence</div>
      <h1 className="mt-2 text-3xl font-semibold">Se connecter</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">Connectez-vous pour accéder aux analyses PFD de cet espace de travail.</p>
      <form className="mt-7 space-y-4" onSubmit={submit}>
        <label className="block text-sm font-semibold">E-mail<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1.5 w-full border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-[#073d92]" /></label>
        <label className="block text-sm font-semibold">Mot de passe<input required minLength={6} type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1.5 w-full border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-[#073d92]" /></label>
        {message && <p className="border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{message}</p>}
        <button disabled={busy} className="flex w-full items-center justify-center gap-2 bg-[#073d92] px-5 py-3 font-bold text-white disabled:opacity-60">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Connexion</button>
      </form>
      <p className="mt-5 text-sm text-slate-500">Votre administrateur crée votre compte et vous affecte aux projets.</p>
    </div>
  </div>
}

/* ─── HEADER ─────────────────────────────────────────────────────────────── */
function Header({ route, go, mobileOpen, setMobileOpen, userEmail, onSignOut }: {
  route: Route; go: (r: Route) => void; mobileOpen: boolean; setMobileOpen: (v: boolean) => void; userEmail: string; onSignOut: () => void
}) {
  return (
    <header className="sticky top-0 z-50 shadow-sm">
      <div className="bg-[#073d92] text-white">
        <div className="mx-auto max-w-7xl px-5 py-2 text-[10px] font-bold uppercase tracking-[.18em] lg:px-8">
          Intelligence d’ingénierie pour diagrammes de flux industriels
        </div>
      </div>
      <div className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 lg:px-8">
          {/* Logo */}
          <div className="flex items-center gap-4">
            <button onClick={() => go('home')} className="flex items-center gap-3 text-left">
              <span className="border-r border-slate-200 pr-4">
                <img src="/jesa-logo.png" alt="JESA" className="h-8 w-auto" />
              </span>
              <span className="hidden font-semibold tracking-tight text-[#073d92] sm:block">PFD Intelligence</span>
            </button>
          </div>
          {/* Desktop nav */}
          <nav className="hidden items-center gap-5 md:flex">
            {nav.map(([id, label]) => (
              <button key={id} onClick={() => go(id)}
                className={`relative border-b-2 py-2 text-sm font-semibold transition-all duration-200 ${
                  route === id
                    ? 'border-[#073d92] text-[#073d92]'
                    : 'border-transparent text-slate-600 hover:border-[#073d92]/40 hover:text-[#073d92]'
                }`}>
                {label}
              </button>
            ))}
            <span className="hidden max-w-36 truncate text-xs text-slate-500 lg:block" title={userEmail}>{userEmail}</span>
            <button onClick={onSignOut} title="Se déconnecter" className="hidden p-2 text-slate-500 hover:text-[#073d92] md:block"><LogOut className="h-4 w-4" /></button>
          </nav>
          {/* Mobile toggle */}
          <button className="text-[#073d92] md:hidden" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Toggle navigation">
            {mobileOpen ? <X /> : <Menu />}
          </button>
        </div>
        <AnimatePresence>
          {mobileOpen && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
              className="border-t border-slate-200 bg-white px-5 pb-4 md:hidden overflow-hidden">
              {nav.map(([id, label]) => (
                <button key={id} onClick={() => go(id)}
                  className="block w-full border-b border-slate-100 py-3 text-left text-sm font-semibold text-slate-700">
                  {label}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </header>
  )
}

/* ─── PAGES ROUTER ───────────────────────────────────────────────────────── */
function Pages(props: {
  route: Route; go: (r: Route) => void; summary: Summary; equipment: Equipment[]
  connections: Connection[]; arrows: FlowArrow[]; graph: Graph | null; raw: unknown
}) {
  if (props.route === 'home')   return <Home {...props} />
  if (props.route === 'upload') return <UploadPage />
  const section = <ResultsTabs active={props.route} go={props.go} />
  const body: Record<Exclude<Route, 'home' | 'upload' | 'projects' | 'users' | 'settings'>, JSX.Element> = {
    analysis:     <Dashboard summary={props.summary} go={props.go} />,
    equipment:    <EquipmentPage equipment={props.equipment} connections={props.connections} />,
    connectivity: <ConnectivityPage connections={props.connections} />,
    arrows:       <ArrowsPage arrows={props.arrows} />,
    graph:        <GraphPage graph={props.graph!} equipment={props.equipment} />,
    json:         <JsonPage raw={props.raw} />,
  }
  return (
    <div className="mx-auto max-w-7xl px-5 py-10 lg:px-8">
      <motion.div initial="hidden" animate="visible" variants={fadeUp} className="mb-8">
        <div className="eyebrow">PFD-230 / demonstration workspace</div>
        <h1 className="display mt-3 text-4xl font-semibold text-white sm:text-6xl">Analysis results</h1>
        <p className="mt-4 max-w-2xl text-slate-300">
          Automated equipment detection, topology extraction and process graph structuring.
        </p>
      </motion.div>
      {section}
      {body[props.route as Exclude<Route, 'home' | 'upload' | 'projects' | 'users' | 'settings'>]}
    </div>
  )
}

/* ─── HERO ANIMATION (SVG + Framer Motion) ───────────────────────────────── */
function HeroAnimation() {
  const pipes = [
    { d: 'M 60 160 L 340 160 L 340 280', id: 'p1' },
    { d: 'M 340 160 L 620 160 L 620 240', id: 'p2' },
    { d: 'M 620 160 L 860 160 L 860 300', id: 'p3' },
    { d: 'M 180 300 L 180 420 L 480 420', id: 'p4' },
    { d: 'M 480 420 L 720 420 L 720 320', id: 'p5' },
  ]
  const boxes = [
    { x: 40,  y: 130, w: 120, h: 56, label: 'PUMP-01',    delay: 0.4 },
    { x: 280, y: 250, w: 120, h: 56, label: 'TANK-01',    delay: 0.7 },
    { x: 565, y: 215, w: 120, h: 56, label: 'SAMPLER-01', delay: 1.0 },
    { x: 800, y: 270, w: 120, h: 56, label: 'CYCLONE-01', delay: 1.3 },
    { x: 430, y: 390, w: 120, h: 56, label: 'CELL-01',    delay: 1.6 },
  ]
  return (
    <svg
      viewBox="0 0 960 500"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full pointer-events-none select-none"
      aria-hidden="true"
      style={{ opacity: 0.28, zIndex: 2 }}>

      {/* Pipe paths */}
      {pipes.map(({ d, id }, i) => (
        <motion.path
          key={id} d={d} fill="none"
          stroke="rgba(147,197,253,0.7)" strokeWidth="1.5"
          strokeDasharray="1 1"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ delay: 0.3 + i * 0.25, duration: 1.8, ease: 'easeInOut' }}
        />
      ))}

      {/* Bounding boxes */}
      {boxes.map(({ x, y, w, h, label, delay }, i) => (
        <motion.g key={i}
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay, duration: 0.5, ease: 'easeOut' }}>
          <rect x={x} y={y} width={w} height={h}
            fill="rgba(96,165,250,0.07)"
            stroke="rgba(147,197,253,0.55)" strokeWidth="1"
            strokeDasharray="4 3" />
          {/* Corner ticks */}
          {[[0,0],[w,0],[0,h],[w,h]].map(([cx,cy], ci) => (
            <g key={ci}>
              <line x1={x+cx} y1={y+cy} x2={x+cx+(cx===0?4:-4)} y2={y+cy}
                stroke="rgba(147,197,253,0.8)" strokeWidth="1.2" />
              <line x1={x+cx} y1={y+cy} x2={x+cx} y2={y+cy+(cy===0?4:-4)}
                stroke="rgba(147,197,253,0.8)" strokeWidth="1.2" />
            </g>
          ))}
          {/* OCR label */}
          <motion.text x={x + w/2} y={y - 6}
            textAnchor="middle" fontSize="8"
            fontFamily="ui-monospace, monospace"
            fill="rgba(186,230,253,0.85)"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            transition={{ delay: delay + 0.3, duration: 0.4 }}>
            {label}
          </motion.text>
        </motion.g>
      ))}

      {/* Connection nodes (dots at junctions) */}
      {[
        [340, 160], [620, 160], [180, 420], [480, 420],
      ].map(([cx, cy], i) => (
        <motion.circle key={i} cx={cx} cy={cy} r="4"
          fill="rgba(147,197,253,0.6)" stroke="rgba(186,230,253,0.5)" strokeWidth="1"
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 1.2 + i * 0.15, duration: 0.35, type: 'spring' }}
        />
      ))}

      {/* Floating scan line */}
      <motion.line x1="0" y1="200" x2="960" y2="200"
        stroke="rgba(147,197,253,0.12)" strokeWidth="40"
        initial={{ y: -40, opacity: 0 }}
        animate={{ y: [0, 500], opacity: [0, 0.6, 0] }}
        transition={{ delay: 2.2, duration: 2.5, ease: 'easeInOut', repeat: Infinity, repeatDelay: 5 }}
      />

      {/* Traveling dots on pipe p1 */}
      {[0, 1, 2].map(i => (
        <motion.circle key={i} r="3"
          fill="rgba(186,230,253,0.9)"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ delay: 2 + i * 0.9, duration: 2.4, repeat: Infinity, repeatDelay: 3 }}>
          <animateMotion
            dur="2.4s" repeatCount="indefinite"
            begin={`${2 + i * 0.9}s`}
            path="M 60 160 L 340 160 L 340 280" />
        </motion.circle>
      ))}

      {/* Graph edge lines (thin dashed, bottom area) */}
      {[
        [60, 320, 280, 320],
        [280, 320, 480, 380],
        [480, 380, 680, 340],
      ].map(([x1, y1, x2, y2], i) => (
        <motion.line key={i}
          x1={x1} y1={y1} x2={x2} y2={y2}
          stroke="rgba(147,197,253,0.35)" strokeWidth="1"
          strokeDasharray="6 4"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ delay: 2.5 + i * 0.3, duration: 1, ease: 'easeOut' }}
        />
      ))}
    </svg>
  )
}

/* ─── HOME ───────────────────────────────────────────────────────────────── */
function Home({ go, userName = 'Utilisateur', role = 'user' }: { go: (r: Route) => void; userName?: string; role?: 'admin' | 'user' }) {
  const [overview, setOverview] = useState<{ projects: number; pfds: number; users: number|null; completed:number; running:number; recent:Array<{project_id:string;pfd_id:string;analysis_id:string;project_name:string;original_filename:string;status:string}> } | null>(null)
  useEffect(() => {
    api<NonNullable<typeof overview>>('/api/workspace')
      .then(setOverview)
      .catch(() => setOverview(null))
  }, [])
  return (
    <>
      <section className="workspace-welcome"><div><div className="eyebrow">Accueil</div><h1 className="mt-2 text-3xl font-semibold text-slate-900">Bonjour {userName} 👋</h1><p className="mt-2 text-sm text-slate-600">Analysez vos diagrammes de flux de processus en quelques clics.</p></div><button onClick={() => go('projects')} className="inline-flex items-center gap-2 bg-[#073d92] px-5 py-3 text-sm font-bold text-white"><Folder className="h-4 w-4" /> Voir mes projets</button></section>
      <section className="jesa-hero relative overflow-hidden">
        <div className="relative mx-auto flex min-h-[300px] max-w-7xl items-end px-5 py-10 lg:px-8">
          <div className="max-w-2xl">
            <div className="text-xs font-bold uppercase tracking-[.2em] text-blue-200">PFD Intelligence / JESA</div>
            <h2 className="mt-4 text-3xl font-bold leading-tight tracking-[-.03em] text-white sm:text-4xl">Centralisez vos projets industriels.</h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-blue-50">Sélectionnez un projet, téléversez ses PFD et laissez PFD Intelligence structurer les informations.</p>
          </div>
        </div>
      </section>
      {/* ── KPI STRIP ── */}
      <section className="bg-[#f3f5f7] py-10">
        <div className="mx-auto max-w-7xl px-5 lg:px-8">
          <motion.div className="mb-7 max-w-2xl"
            initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp}>
            <div className="eyebrow">Votre espace de travail</div>
            <h2 className="mt-2 text-3xl font-bold tracking-[-.035em] text-slate-900">Pilotez vos projets PFD.</h2>
            <p className="mt-2 text-sm text-slate-600">Chaque analyse reste rattachée à son projet et à son document.</p>
          </motion.div>
          <motion.div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
            initial="hidden" whileInView="visible" viewport={{ once: true }} variants={staggerContainer}>
            {[
              [overview ? String(overview.projects) : '—', 'Projets accessibles'],
              [overview ? String(overview.pfds) : '—', 'PFD téléversés'],
              [overview ? String(overview.completed) : '—', 'Analyses terminées'],
              [overview ? String(overview.running) : '—', 'Analyses en cours'],
              ...(role==='admin' ? [[overview ? String(overview.users) : '—', 'Utilisateurs']] : []),
            ].map(([value, label]) => (
              <motion.div key={String(label)} variants={fadeUp} className="stat-card rounded-sm border border-slate-200 bg-white shadow-sm">
                <div className="display text-5xl font-bold tracking-[-.05em] text-[#073d92]">{value}</div>
                <div className="mt-3 text-xs font-semibold uppercase tracking-[.12em] text-slate-500">{label}</div>
              </motion.div>
            ))}
          </motion.div>
          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            <div className="rounded-sm border border-dashed border-[#9bb9df] bg-white p-7 text-center shadow-sm">
              <div className="eyebrow">Démarrer</div>
              <h3 className="mt-2 text-lg font-semibold text-slate-900">{role==='admin'?'Créez ou ouvrez un projet.':'Ouvrez un projet qui vous est affecté.'}</h3>
              <button onClick={() => go('projects')} className="mt-5 inline-flex items-center gap-2 bg-[#073d92] px-5 py-3 text-sm font-bold text-white">{role === 'admin' ? 'Gérer les projets' : 'Voir mes projets'} <ChevronRight size={16} /></button>
            </div>
            <div className="rounded-sm border border-slate-200 bg-white p-7 shadow-sm">
              <div className="eyebrow">Analyses récentes</div>
              {!overview?.recent.length && <p className="mt-3 text-sm text-slate-600">Aucune analyse accessible pour le moment.</p>}
              {overview?.recent.map(j=><a key={j.analysis_id} href={`#projects/${j.project_id}/pfds/${j.pfd_id}/${j.status==='completed'?'results':'analysis'}/${j.analysis_id}`} className="mt-3 block border-b py-2 text-sm"><strong>{j.original_filename}</strong><span className="block text-slate-500">{j.project_name} · {JOB_MESSAGES[j.status]||j.status}</span></a>)}
            </div>
          </div>
        </div>
      </section>

      {/* ── DATA QUALITY ── */}
      <section className="bg-white py-16">
        <div className="mx-auto max-w-7xl px-5 lg:px-8">
          <section className="border border-amber-200 bg-amber-50 p-6">
            <div className="eyebrow text-amber-700">Résultats à vérifier</div>
            <h2 className="mt-3 text-xl font-semibold text-slate-900">
              L’application expose les détections et leurs incertitudes sans inventer de conclusion métier.
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-700">
              Les associations OCR ↔ YOLO peuvent être associées, ambiguës ou non associées. La topologie et les
              connexions ne sont affichées que lorsqu’elles ont réellement été calculées pour le document concerné.
            </p>
          </section>
        </div>
      </section>
    </>
  )
}

/* ─── ANIMATED STAT ──────────────────────────────────────────────────────── */
function AnimatedStat({ value, warn = false }: { value: number; warn?: boolean }) {
  return (
    <div className={`display text-5xl font-bold tracking-[-.05em] ${warn ? 'text-amber-600' : 'text-[#073d92]'}`}>
      {format(value)}
    </div>
  )
}

/* ─── RESULTS TABS ───────────────────────────────────────────────────────── */
function ResultsTabs({ active, go }: { active: Route; go: (r: Route) => void }) {
  const tabs: Array<[Route, string]> = [
    ['analysis', 'Overview'], ['equipment', 'Equipment'], ['connectivity', 'Connectivity'],
    ['arrows', 'Flow Arrows'], ['graph', 'Graph'], ['json', 'JSON'],
  ]
  return (
    <div className="mb-8 flex gap-1 overflow-x-auto border-b border-white/10">
      {tabs.map(([id, label]) => (
        <button key={id} onClick={() => go(id)}
          className={`relative whitespace-nowrap px-4 py-3 text-sm font-medium transition-colors duration-150 ${
            active === id ? 'text-cyan-100' : 'text-slate-400 hover:text-white'
          }`}>
          {label}
          {active === id && (
            <motion.div layoutId="tab-underline"
              className="absolute bottom-0 left-0 right-0 h-0.5 bg-cyan-200"
              transition={{ type: 'spring', stiffness: 500, damping: 40 }} />
          )}
        </button>
      ))}
    </div>
  )
}

/* ─── DASHBOARD ──────────────────────────────────────────────────────────── */
function Dashboard({ summary, go }: { summary: Summary; go: (r: Route) => void }) {
  return (
    <div className="space-y-8">
      <motion.section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        initial="hidden" animate="visible" variants={staggerContainer}>
        <motion.div variants={fadeUp}><Stat value={summary.equipment}            label="Equipment" /></motion.div>
        <motion.div variants={fadeUp}><Stat value={summary.physical_arrows}      label="Flow arrows" /></motion.div>
        <motion.div variants={fadeUp}><Stat value={summary.process_connections}  label="Process connections" /></motion.div>
        <motion.div variants={fadeUp}><Stat value={summary.unresolved_crossings} label="Unresolved crossings" tone="warn" /></motion.div>
      </motion.section>
      <section className="glass grid gap-6 p-6 lg:grid-cols-[.9fr_1.1fr]">
        <div>
          <div className="eyebrow">Document intelligence</div>
          <h2 className="mt-3 text-2xl font-semibold">PFD-230 Analysis</h2>
          <dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
            <Data label="File"                  value={summary.document.filename} />
            <Data label="Dimensions"            value={`${summary.document.image_width} × ${summary.document.image_height}`} />
            <Data label="OCR text regions"      value={String(summary.ocr_text_regions)} />
            <Data label="Mean OCR confidence"   value={format(summary.ocr_mean_confidence, 3)} />
            <Data label="Geometry ports"        value={String(summary.geometry_ports)} />
            <Data label="Unknown edge directions" value={String(summary.unknown_edge_directions)} />
          </dl>
        </div>
        <Pipeline statuses={summary.pipeline} />
      </section>
      <section className="grid gap-4 md:grid-cols-3">
        <MetricLink value={summary.connected_equipment}    label="Connected equipment"          onClick={() => go('connectivity')} />
        <MetricLink value={summary.isolated_equipment}     label="Isolated equipment"            onClick={() => go('equipment')} />
        <MetricLink value={summary.unknown_edge_directions} label="Unknown edge directions"       onClick={() => go('graph')} />
      </section>
      <DataQuality summary={summary} />
    </div>
  )
}

/* ─── GENERIC RESULT TYPE ────────────────────────────────────────────────── */
type GenericResult = {
  analysis_id: string; original_filename: string; scope: string; not_run: string[]
  summary: {
    ocr_texts: number; ocr_mean_confidence: number | null
    yolo_detections: number; class_counts: Record<string, number>
    tag_candidates: number; association_status_counts: Record<string, number>
  }
  detections: Array<{ id: string; class_name: string; confidence: number; bbox: number[] }>
  associations: Array<{
    candidate_id: string; text: string; confidence: number; status: string
    equipment?: { detection_id: string; class_name: string; distance_px: number } | null
  }>
  validated_graph: {
    available: boolean; reason?: string; label?: string; note?: string
    equipment_nodes?: number; connections?: number; isolated_equipment?: number
    preview_html?: string; preview_png?: string
  }
  artifacts: Record<string, string | null>
}

/* ─── JOB STATUS TRACKER ─────────────────────────────────────────────────── */
function JobStatusTracker({ status }: { status: string }) {
  const failedIdx = status === 'failed' ? JOB_STEPS.findIndex(s => s.id === 'completed') : -1
  const activeIdx = JOB_STEPS.findIndex(s => s.id === status)
  const effectiveIdx = status === 'failed' ? JOB_STEPS.length : activeIdx

  return (
    <div className="glass p-5">
      <div className="eyebrow mb-4">Progression de l’analyse</div>
      <div className="relative">
        {/* vertical connector */}
        <div className="absolute left-[4px] top-3 bottom-3 w-px bg-slate-200" />
        <div className="space-y-1 pl-1">
          {JOB_STEPS.map((step, i) => {
            const isDone   = i < effectiveIdx && status !== 'failed'
            const isActive = i === activeIdx && status !== 'failed' && status !== 'completed'
            const isErr    = status === 'failed' && i >= effectiveIdx - 1
            const stepClass = isDone ? 'done' : isActive ? 'active' : isErr ? 'error' : ''
            return (
              <motion.div key={step.id}
                className={`job-step ${stepClass}`}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.06 }}>
                <div className="job-step-dot" />
                <span>{step.label}</span>
                {isDone   && <CheckCircle2 size={13} className="ml-auto text-green-600" />}
                {isActive && <Loader2 size={13} className="ml-auto animate-spin text-[#073d92]" />}
                {isErr    && <XCircle size={13} className="ml-auto text-red-500" />}
              </motion.div>
            )
          })}
        </div>
      </div>
      {status === 'completed' && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }}
          className="mt-4 flex items-center gap-2 border border-green-200 bg-green-50 px-3 py-2 text-xs font-semibold text-green-700">
          <CheckCheck size={14} /> Analyse terminée avec succès
        </motion.div>
      )}
      {status === 'failed' && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }}
          className="mt-4 flex items-center gap-2 border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          <XCircle size={14} /> Échec de l’analyse
        </motion.div>
      )}
    </div>
  )
}

/* ─── UPLOAD PAGE ────────────────────────────────────────────────────────── */
type Project = { id: string; name: string; description: string; created_at: string; pfd_count: number; members?: Array<{ id: string; name: string; email: string; role: string }> }
type PfdItem = { id: string; filename: string; uploaded_at: string; project_id: string }

// The repository ships one neutral industrial panorama. Reframing it per project
// keeps the visual language consistent while giving every project its own cover.
const PROJECT_COVER_POSITIONS = ['18% center', '36% center', '54% center', '72% center', '86% center', '100% center']

function ProjectsPage({ resourcePath, onNavigate }: { resourcePath: string; onNavigate: (path: string) => void }) {
  const [items, setItems] = useState<Project[]>([])
  const [selected, setSelected] = useState<Project | null>(null)
  const [pfds, setPfds] = useState<PfdItem[]>([])
  const [message, setMessage] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [user, setUser] = useState<{ role: string } | null>(null)
  const load = async () => { try { const [p, me] = await Promise.all([api<{items:Project[]}>('/api/projects'), api<{role:string}>('/api/auth/me')]); setItems(p.items); setUser(me) } catch (e) { setMessage(e instanceof Error ? e.message : 'Erreur de chargement') } }
  useEffect(() => { void load() }, [])
  const open = async (p: Project) => { onNavigate('projects/' + p.id); setSelected(await api<Project>('/api/projects/' + p.id)); setPfds((await api<{items:PfdItem[]}>('/api/projects/' + p.id + '/pfds')).items) }
  const upload = async () => { if (!selected || !file) return; const form = new FormData(); form.append('file', file); try { await api('/api/projects/' + selected.id + '/pfds', {method:'POST', body:form}); setMessage('PFD téléversé. Cliquez sur Analyser pour lancer le pipeline.'); setFile(null); await open(selected) } catch (e) { setMessage(e instanceof Error ? e.message : 'Erreur de téléversement') } }
  const analyze = async (id: string) => { try { const job = await api<{analysis_id:string}>('/api/pfds/' + id + '/analyze', {method:'POST'}); onNavigate('projects/' + selected?.id + '/pfds/' + id + '/analysis/' + job.analysis_id); } catch (e) { setMessage(e instanceof Error ? e.message : 'Erreur') } }
  useEffect(() => { const pathParts = resourcePath.split('/'); const id = pathParts[1]; if (pathParts.length === 2 && id && items.length) { const found = items.find(p => p.id === id); if (found && !selected) void open(found) } }, [items, resourcePath])
  if (resourcePath.includes('/analysis/')) return <ProjectAnalysisPage resourcePath={resourcePath} onNavigate={onNavigate} />
  if (resourcePath.includes('/results/')) return <ProjectResultsPage resourcePath={resourcePath} />
  return <div className="mx-auto max-w-7xl px-5 py-12 lg:px-8"><div className="flex flex-wrap items-end justify-between gap-4"><div><div className="eyebrow">Espace métier</div><h1 className="display mt-3 text-5xl text-white">{selected ? selected.name : 'Projets'}</h1><p className="mt-4 max-w-2xl text-slate-300">{selected ? selected.description : 'Sélectionnez un projet pour accéder à ses PFD et lancer l’analyse.'}</p></div>{!selected && <input aria-label="Rechercher un projet" placeholder="Rechercher un projet…" className="border border-slate-200 bg-white px-4 py-3 text-sm outline-none" onChange={e => setItems(items.filter(p => p.name.toLowerCase().includes(e.target.value.toLowerCase())))} />}</div>{message && <p className="mt-6 border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">{message}</p>}{!selected && <><div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">{items.map((p, index) => <button key={p.id} onClick={() => void open(p)} className="glass group overflow-hidden text-left hover:border-[#073d92]"><div className="project-cover" style={{ backgroundPosition: PROJECT_COVER_POSITIONS[index % PROJECT_COVER_POSITIONS.length] }} role="img" aria-label={`Illustration industrielle du ${p.name}`}><span className="project-cover-label">PFD Intelligence</span><span className="project-cover-count">{p.pfd_count} PFD</span></div><div className="p-5"><div className="text-xl font-semibold text-slate-900">{p.name}</div><p className="mt-2 min-h-10 text-sm text-slate-600">{p.description || 'Aucune description'}</p><div className="mt-5 flex justify-end text-xs font-bold uppercase tracking-wider text-[#073d92]"><span>Ouvrir →</span></div></div></button>)}</div></>}{selected && <section className="glass mt-8 p-6"><button className="text-sm font-semibold text-[#073d92]" onClick={() => { setSelected(null); onNavigate('projects') }}>← Tous les projets</button><div className="mt-5 flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-2xl font-semibold text-slate-900">PFD du projet</h2><p className="mt-1 text-sm text-slate-500">Membres : {selected.members?.map(m => m.name).join(', ') || 'Aucun membre'}</p></div><div className="flex flex-wrap gap-3"><input id="project-pfd-upload" className="hidden" type="file" accept="application/pdf" onChange={e => setFile(e.target.files?.[0] || null)} /><label htmlFor="project-pfd-upload" className="cursor-pointer border border-[#073d92] px-4 py-2 font-semibold text-[#073d92]">Choisir un PDF</label><button disabled={!file} onClick={() => void upload()} className="bg-[#073d92] px-4 py-2 font-semibold text-white disabled:opacity-40">+ Téléverser un PFD</button></div></div><div className="mt-7 space-y-2">{pfds.map(p => <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 py-3"><div><span className="font-medium text-slate-700">{p.filename}</span><div className="text-xs text-slate-500">Ajouté le {new Date(p.uploaded_at).toLocaleDateString('fr-FR')}</div></div><button onClick={() => void analyze(p.id)} className="border border-[#073d92] px-3 py-1 text-sm font-semibold text-[#073d92]">Analyser</button></div>)}</div></section>}</div>
}

function SettingsPage({ user }: { user: LocalUser }) {
  return <div className="mx-auto max-w-5xl px-5 py-12 lg:px-8"><div className="eyebrow">Compte</div><h1 className="display mt-3 text-5xl text-white">Paramètres</h1><p className="mt-4 text-slate-300">Gérez votre profil et vos informations d’accès.</p><section className="glass mt-8 max-w-2xl p-7"><h2 className="text-xl font-semibold text-slate-900">Informations du profil</h2><div className="mt-6 grid gap-4 sm:grid-cols-2"><div><label className="text-xs font-bold uppercase tracking-wider text-slate-500">Nom complet</label><div className="mt-1 border border-slate-200 bg-slate-50 px-3 py-2.5">{user.name}</div></div><div><label className="text-xs font-bold uppercase tracking-wider text-slate-500">Rôle</label><div className="mt-1 border border-slate-200 bg-slate-50 px-3 py-2.5 capitalize">{user.role}</div></div><div className="sm:col-span-2"><label className="text-xs font-bold uppercase tracking-wider text-slate-500">E-mail</label><div className="mt-1 border border-slate-200 bg-slate-50 px-3 py-2.5">{user.email}</div></div></div></section></div>
}

function ProjectAnalysisPage({ resourcePath, onNavigate }: { resourcePath: string; onNavigate: (path: string) => void }) {
  const parts = resourcePath.split('/'); const projectId = parts[1] || ''; const pfdId = parts[3] || ''; const analysisId = parts[5] || ''
  const [job, setJob] = useState<{status:string;message:string;original_filename?:string} | null>(null)
  useEffect(() => { let timer: number | undefined; const poll = async () => { try { const next=await api<NonNullable<typeof job>>('/api/analyses/'+analysisId); setJob(next); if (!['completed','failed'].includes(next.status)) timer=window.setTimeout(poll,2500) } catch { setJob({status:'failed',message:'Impossible de lire le statut de l’analyse.'}) } }; if(analysisId) void poll(); return () => { if(timer) window.clearTimeout(timer) } }, [analysisId])
  const index = JOB_STEPS.findIndex(s => s.id === job?.status)
  return <div className="mx-auto max-w-4xl px-5 py-12 lg:px-8"><button onClick={() => onNavigate('projects/'+projectId)} className="text-sm font-semibold text-blue-200">← Retour au projet</button><div className="eyebrow mt-8">Analyse du PFD</div><h1 className="display mt-3 text-5xl text-white">Traitement en cours</h1><p className="mt-4 text-slate-300">PFD : {job?.original_filename || pfdId} · analysis_id : {analysisId}</p><section className="glass mt-8 p-8">{JOB_STEPS.map((step,i) => <div key={step.id} className="flex items-center gap-4 border-b border-slate-100 py-4 last:border-0"><span className={`grid h-8 w-8 place-items-center rounded-full text-sm font-bold ${job?.status === 'failed' && i === index ? 'bg-red-100 text-red-700' : i <= index ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>{i < index ? '✓' : i === index ? '•' : '○'}</span><span className={i <= index ? 'font-semibold text-slate-800' : 'text-slate-400'}>{step.label}</span><span className="ml-auto text-xs text-slate-500">{i === index ? (job?.status || 'queued') : ''}</span></div>)}{job?.status === 'failed' && <p className="mt-5 border border-red-200 bg-red-50 p-3 text-sm text-red-800">{job.message}</p>}{job?.status === 'completed' && <button onClick={() => onNavigate('projects/'+projectId+'/pfds/'+pfdId+'/results/'+analysisId)} className="mt-6 bg-[#073d92] px-5 py-3 font-bold text-white">Voir les résultats</button>}</section></div>
}

function ProjectResultsPage({ resourcePath }: { resourcePath: string }) {
  const analysisId = resourcePath.split('/')[5] || ''; const [result,setResult]=useState<GenericResult|null>(null); const [error,setError]=useState('')
  useEffect(() => { api<GenericResult>('/api/analyses/'+analysisId+'/results').then(setResult).catch(e => setError(e instanceof Error ? e.message : 'Erreur')) }, [analysisId])
  if (error) return <ErrorState error={error} />
  if (!result) return <Loading />
  return <div className="mx-auto max-w-7xl px-5 py-10 lg:px-8"><div className="eyebrow">Résultats du PFD</div><h1 className="display mt-3 text-5xl text-white">{result.original_filename}</h1><p className="mt-3 text-slate-300">Analyse réelle · {result.analysis_id}</p><GenericResultPanel result={result} /></div>
}

function UsersPage() {
  const [items, setItems] = useState<Array<{id:string;name:string;email:string;role:string;active:number}>>([])
  const [message, setMessage] = useState('')
  const load = async () => { try { setItems((await api<{items: typeof items}>('/api/users')).items) } catch (e) { setMessage(e instanceof Error ? e.message : 'Erreur') } }
  useEffect(() => { void load() }, [])
  const create = async () => { const email = window.prompt('E-mail du nouvel utilisateur'); const name = window.prompt('Nom complet'); const password = window.prompt('Mot de passe temporaire'); if (!email || !name || !password) return; try { await api('/api/users', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,name,password,role:'user'})}); setMessage('Utilisateur créé.'); await load() } catch (e) { setMessage(e instanceof Error ? e.message : 'Erreur') } }
  return <div className="mx-auto max-w-5xl px-5 py-12 lg:px-8"><div className="flex flex-wrap items-end justify-between gap-4"><div><div className="eyebrow">Administration</div><h1 className="display mt-3 text-5xl text-white">Utilisateurs</h1><p className="mt-4 text-slate-300">Créez et gérez les accès aux projets.</p></div><button onClick={() => void create()} className="inline-flex items-center gap-2 bg-[#1671df] px-5 py-3 font-bold text-white"><Plus className="h-4 w-4" /> Créer un utilisateur</button></div>{message && <p className="mt-6 border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">{message}</p>}<div className="glass mt-8 overflow-hidden"><div className="grid grid-cols-[1.5fr_2fr_1fr_1fr] gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-bold uppercase tracking-wider text-slate-500"><span>Nom</span><span>E-mail</span><span>Rôle</span><span>Statut</span></div>{items.map(item => <div key={item.id} className="grid grid-cols-[1.5fr_2fr_1fr_1fr] gap-4 border-b border-slate-100 px-5 py-4 text-sm"><span className="font-semibold text-slate-800">{item.name}</span><span className="text-slate-600">{item.email}</span><span className="capitalize text-slate-600">{item.role}</span><span className={item.active ? 'text-emerald-600' : 'text-red-600'}>{item.active ? 'Actif' : 'Désactivé'}</span></div>)}</div></div>
}

function Sidebar({ route, go, user, onSignOut }: { route: Route; go: (r: Route) => void; user: LocalUser; onSignOut: () => void }) {
  const links: Array<[Route, string, typeof HomeIcon]> = [['home','Accueil',HomeIcon], ['projects','Projets',Folder], ...(user.role === 'admin' ? [['users','Utilisateurs',UserRound] as [Route,string,typeof HomeIcon]] : []), ['settings','Paramètres',Settings]]
  return <aside className="app-sidebar"><div className="sidebar-brand"><div className="sidebar-mark"><span>⌬</span></div><div><div className="font-bold tracking-tight">PFD Intelligence</div><div className="text-[11px] text-blue-200">JESA</div></div></div><nav className="sidebar-nav">{links.map(([id,label,Icon]) => <button key={id} onClick={() => go(id)} className={route === id ? 'active' : ''}><Icon className="h-4 w-4" />{label}</button>)}</nav><div className="sidebar-footer"><div>Parse. Structure. Understand.</div><div className="mt-3 text-[11px] text-blue-200/60">JESA © {new Date().getFullYear()}</div><button onClick={onSignOut} className="mt-5 flex items-center gap-2 text-xs text-blue-100/70 hover:text-white"><LogOut className="h-3.5 w-3.5" /> Déconnexion</button></div></aside>
}

function UploadPage() {
  const input    = useRef<HTMLInputElement>(null)
  const [file, setFile]         = useState<File | null>(null)
  const [message, setMessage]   = useState('')
  const [analysisId, setAnalysisId] = useState('')
  const [working, setWorking]   = useState(false)
  const [jobStatus, setJobStatus] = useState('')
  const [result, setResult]     = useState<GenericResult | null>(null)
  const [dragging, setDragging] = useState(false)

  const selectJob = (job: { analysis_id: string; status: string; message: string }) => {
    setAnalysisId(job.analysis_id)
    setJobStatus(job.status)
    setWorking(['queued', 'rendering_pdf', 'running_ocr', 'running_yolo', 'associating'].includes(job.status))
    setMessage(jobMessage(job))
  }

  useEffect(() => {
    const restoreLatestRealAnalysis = async () => {
      try {
        const active = await api<{ job: { analysis_id: string; status: string; message: string } | null }>('/api/analyses/active')
        if (active.job) {
          selectJob(active.job)
          return
        }

        // A browser refresh must not make a completed real analysis appear to
        // have vanished.  Restore only the latest uploaded-PDF result; this
        // never falls back to the frozen PFD-230 demonstration data.
        const latest = await api<{ job: { analysis_id: string; status: string; message: string } | null }>('/api/analyses/latest')
        if (latest.job?.status === 'completed') {
          selectJob(latest.job)
          setResult(await api<GenericResult>('/api/analyses/' + latest.job.analysis_id + '/results'))
        } else {
          localStorage.removeItem('pfd-analysis-id')
        }
      } catch {
        // The upload form remains usable even if the optional restore request fails.
      }
    }
    void restoreLatestRealAnalysis()
  }, [])

  useEffect(() => {
    if (!analysisId) return
    let timer: number | undefined
    const refresh = async () => {
      try {
        const job = await api<{ status: string; message: string }>('/api/analyses/' + analysisId)
        setJobStatus(job.status)
        setMessage(jobMessage({ ...job, analysis_id: analysisId }))
        const busy = ['queued', 'rendering_pdf', 'running_ocr', 'running_yolo', 'associating'].includes(job.status)
        setWorking(busy)
        if (job.status === 'completed') {
          localStorage.removeItem('pfd-analysis-id')
          setResult(await api<GenericResult>('/api/analyses/' + analysisId + '/results'))
        }
        else if (busy) timer = window.setTimeout(refresh, 2500)
      } catch {
        setMessage(`Impossible de lire le statut de l’analyse ${analysisId}.`)
      }
    }
    refresh()
    return () => { if (timer) window.clearTimeout(timer) }
  }, [analysisId])

  useEffect(() => {
    if (!analysisId || !working) return
    const cancelWhenLeaving = () => {
      // sendBeacon is designed for page close/navigation and lets the backend
      // stop the dedicated local worker even after the browser has gone away.
      navigator.sendBeacon(`/api/analyses/${analysisId}/cancel`)
    }
    window.addEventListener('pagehide', cancelWhenLeaving)
    return () => window.removeEventListener('pagehide', cancelWhenLeaving)
  }, [analysisId, working])

  const send = async () => {
    if (!file || working) return
    const form = new FormData()
    form.append('file', file)
    setWorking(true); setResult(null)
    try {
      const r = await api<{ message: string; analysis_id: string; status: string }>('/api/analyze', { method: 'POST', body: form })
      localStorage.setItem('pfd-analysis-id', r.analysis_id)
      setAnalysisId(r.analysis_id)
      setJobStatus(r.status)
      setMessage(jobMessage(r))
    } catch (reason) {
      setWorking(false)
      const detail = reason instanceof Error ? reason.message : ''
      if (detail.startsWith('409:')) {
        setMessage('Une analyse est déjà en cours sur cette machine. Rattachement à son suivi en cours…')
        try {
          const { job } = await api<{ job: { analysis_id: string; status: string; message: string } | null }>('/api/analyses/active')
          if (job) selectJob(job)
        } catch {
          setMessage('Une analyse est déjà en cours, mais son statut est temporairement indisponible.')
        }
      } else {
        setMessage(`Erreur API : ${detail || 'erreur inconnue'}.`)
      }
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-12 lg:px-8">
      <motion.div initial="hidden" animate="visible" variants={staggerContainer}>
        <motion.div variants={fadeUp} className="eyebrow">Nouvelle analyse</motion.div>
        <motion.h1 variants={fadeUp} custom={1} className="display mt-4 text-5xl text-white">
          Téléverser un diagramme de flux de processus
        </motion.h1>
        <motion.p variants={fadeUp} custom={2} className="mt-5 max-w-3xl text-slate-300">
          Chaque PDF est analysé séparément par PaddleOCR, YOLO et l’association spatiale des balises OCR ↔ YOLO.
          Les résultats affichés appartiennent exclusivement au document téléversé.
        </motion.p>

        {/* Drop zone */}
        <motion.button variants={fadeUp} custom={3}
          onClick={() => input.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f) }}
          className={`glass mt-10 flex min-h-60 w-full flex-col items-center justify-center border-2 border-dashed p-8 text-center transition-all duration-200 ${
            dragging ? 'border-[#073d92] bg-blue-50/60' : 'border-slate-200 hover:border-[#073d92]/60 hover:bg-blue-50/20'
          }`}>
          <motion.div animate={{ scale: dragging ? 1.15 : 1 }} transition={{ type: 'spring', stiffness: 300 }}>
            <FileUp size={40} className={dragging ? 'text-[#073d92]' : 'text-slate-400'} />
          </motion.div>
          <strong className="mt-5 text-lg text-slate-700">Glissez-déposez le PDF ou parcourez vos fichiers.</strong>
          <span className="mt-2 text-sm text-slate-400">Format accepté : PDF</span>
          <span className={`mt-6 px-4 py-2 text-sm font-medium transition-all duration-200 ${
            file ? 'bg-[#073d92] text-white' : 'bg-slate-100 text-slate-500'
          }`}>
            {file?.name ?? 'Choisir un PDF'}
          </span>
        </motion.button>
        <input ref={input} className="hidden" type="file" accept="application/pdf"
          onChange={e => setFile(e.target.files?.[0] ?? null)} />

        {/* Controls */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
          <span className="text-xs uppercase tracking-[.13em] text-slate-500">
            Pipeline réel — OCR, YOLO et association de balises
          </span>
          <button onClick={send} disabled={!file || working}
            className="inline-flex items-center gap-2 bg-[#073d92] px-6 py-3 text-sm font-bold text-white transition-all duration-200 hover:bg-[#062f71] disabled:cursor-not-allowed disabled:opacity-40">
            {working ? <><Loader2 size={16} className="animate-spin" /> Analyse en cours…</> : <><Zap size={16} /> Analyser</>}
          </button>
        </div>

        {/* Indeterminate progress bar while working */}
        <AnimatePresence>
          {working && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="mt-3 progress-bar-track">
              <div className="progress-bar-fill" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Status message */}
        {message && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
            className="mt-4 flex items-start gap-3 border border-blue-200 bg-blue-50 p-4 text-sm text-[#073d92]">
            <Clock size={16} className="mt-0.5 shrink-0" />
            <span>{message}</span>
          </motion.div>
        )}

        {/* Job timeline */}
        {jobStatus && (
          <motion.div className="mt-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
            <JobStatusTracker status={jobStatus} />
          </motion.div>
        )}

        {/* Results */}
        {result && <GenericResultPanel result={result} />}
      </motion.div>
    </div>
  )
}

/* ─── STATUS BADGE ───────────────────────────────────────────────────────── */
function StatusBadge({ status }: { status: string }) {
  if (status === 'candidate')    return <span className="badge-associated">Associated</span>
  if (status === 'ambiguous' || status === 'to_review') return <span className="badge-ambiguous">Ambiguous</span>
  return                                <span className="badge-unassociated">Unassociated</span>
}

/* ─── GENERIC RESULT PANEL ───────────────────────────────────────────────── */
function GenericResultPanel({ result }: { result: GenericResult }) {
  const approved = result.associations.filter(item => item.status === 'candidate')
  const reviewItems = result.associations.filter(item => item.status !== 'candidate')
  return (
    <motion.section className="mt-8 space-y-6"
      initial="hidden" animate="visible" variants={staggerContainer}>
      {/* Header KPIs */}
      <motion.div variants={fadeUp}
        className="border border-blue-200 bg-blue-50 p-6">
        <div className="eyebrow">Résultats réels de l’analyse</div>
        <h2 className="mt-2 text-2xl font-semibold text-slate-900">{result.original_filename}</h2>
        <p className="mt-2 text-sm text-slate-600">
          {result.scope}. {result.validated_graph.available
            ? 'Le graphe validé du PFD-230 est disponible ci-dessous.'
            : 'La topologie, les conduites et le graphe ne sont pas encore calculés automatiquement pour ce PDF.'}
        </p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [result.summary.ocr_texts,         'Textes OCR'],
            [result.summary.yolo_detections,    'Détections YOLO'],
            [result.summary.tag_candidates,     'Candidats de balises'],
            [approved.length,                   'Associations retenues'],
          ].map(([value, label]) => (
            <div key={String(label)} className="stat-card">
              <AnimatedStat value={value as number} />
              <div className="mt-2 text-xs font-semibold uppercase tracking-[.12em] text-slate-500">{label}</div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* A graph is shown only for a byte-identical PFD-230 upload.  This
          avoids presenting Stage 08 data as if it belonged to another PDF. */}
      {result.validated_graph.available ? (
        <motion.article variants={fadeUp} className="glass overflow-hidden p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="eyebrow">Connectivité validée</div>
              <h3 className="mt-1 text-xl font-semibold text-slate-800">{result.validated_graph.label}</h3>
              <p className="mt-2 max-w-3xl text-sm text-slate-600">{result.validated_graph.note}</p>
            </div>
            <div className="flex gap-2 text-xs font-semibold text-slate-600">
              <span className="border border-slate-200 px-3 py-2">{result.validated_graph.equipment_nodes} équipements</span>
              <span className="border border-slate-200 px-3 py-2">{result.validated_graph.connections} relations</span>
              <span className="border border-slate-200 px-3 py-2">{result.validated_graph.isolated_equipment} isolés</span>
            </div>
          </div>
          {result.validated_graph.preview_html && (
            <ProtectedAsset path={result.validated_graph.preview_html} frame />
          )}
          {result.validated_graph.preview_png && (
            <ProtectedAsset path={result.validated_graph.preview_png}>
              <Download size={14} /> Ouvrir l’image du graphe
            </ProtectedAsset>
          )}
        </motion.article>
      ) : (
        <motion.div variants={fadeUp} className="border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          <strong className="text-slate-800">Graphe de connectivité :</strong> {result.validated_graph.reason}
        </motion.div>
      )}

      {/* Class breakdown + Artifacts */}
      <motion.div variants={fadeUp} className="grid gap-5 lg:grid-cols-2">
        <article className="glass p-5">
          <h3 className="font-semibold text-slate-800">Détections YOLO par classe</h3>
          <div className="mt-4 space-y-2">
            {Object.entries(result.summary.class_counts).map(([name, count]) => (
              <div key={name} className="flex items-center justify-between border-b border-slate-100 py-2 text-sm">
                <ClassPill kind={name} />
                <strong className="tabular-nums">{count}</strong>
              </div>
            ))}
          </div>
        </article>
        <article className="glass p-5">
          <h3 className="font-semibold text-slate-800">Fichiers produits</h3>
          <div className="mt-4 flex flex-col items-start gap-2 text-sm">
            {([
              ['Page rendue',             result.artifacts.ocr_page],
              ['JSON OCR',                result.artifacts.ocr_json],
              ['JSON des détections YOLO', result.artifacts.yolo_json],
              ['JSON des candidats tags', result.artifacts.tag_candidates_json],
              ['JSON des associations',   result.artifacts.associations_json],
              ['Graphe de connectivité (à valider)', result.artifacts.graph_json],
            ] as [string, string | null][]).map(([label, url]) =>
              url ? (
                <ProtectedAsset key={label} path={url}>
                  <Download size={13} /> {label}
                </ProtectedAsset>
              ) : null
            )}
          </div>
        </article>
      </motion.div>

      {/* Associations table */}
      <motion.article variants={fadeUp} className="glass overflow-hidden">
        <div className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-800">Associations OCR ↔ YOLO retenues</h3>
              <p className="mt-1 text-sm text-slate-500">
                Ces associations géométriques restent vérifiables et n’impliquent pas une connexion de procédé.
              </p>
            </div>
          </div>
        </div>
        <div className="max-h-[430px] overflow-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <tr>
                {['Balise OCR', 'Confiance', 'Équipement YOLO', 'Classe', 'Statut'].map(h => (
                  <th key={h} className="px-4 py-3 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {approved.map(item => (
                <tr key={item.candidate_id} className="tbl-row border-t border-slate-100">
                  <td className="px-4 py-3 font-medium">
                    <span className="tag-mono text-slate-800">{item.text}</span>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">{format(item.confidence, 3)}</td>
                  <td className="px-4 py-3 text-slate-600">
                    <span className="tag-mono">{item.equipment?.detection_id ?? '—'}</span>
                  </td>
                  <td className="px-4 py-3">
                    {item.equipment?.class_name ? <ClassPill kind={item.equipment.class_name} /> : '—'}
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={item.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {reviewItems.length > 0 && (
          <details className="border-t border-slate-200 bg-slate-50 px-5 py-4 text-sm">
            <summary className="cursor-pointer font-semibold text-[#073d92]">
              Afficher les {reviewItems.length} candidat(s) ambigus ou non associés
            </summary>
            <ul className="mt-3 space-y-2 text-slate-600">
              {reviewItems.map(item => (
                <li key={item.candidate_id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
                  <span className="tag-mono">{item.text}</span>
                  <StatusBadge status={item.status} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </motion.article>
    </motion.section>
  )
}

/* ─── EQUIPMENT PAGE ─────────────────────────────────────────────────────── */
function EquipmentPage({ equipment, connections }: { equipment: Equipment[]; connections: Connection[] }) {
  const [query, setQuery]       = useState('')
  const [kind, setKind]         = useState('all')
  const [state, setState]       = useState('all')
  const [selected, setSelected] = useState<Equipment | null>(null)
  const classes = [...new Set(equipment.map(e => e.class))]
  const filtered = equipment.filter(e =>
    (e.tag.toLowerCase().includes(query.toLowerCase()) || e.class.includes(query.toLowerCase())) &&
    (kind  === 'all' || e.class === kind) &&
    (state === 'all' || (state === 'connected' ? e.connectivity_status.connected_to_equipment_graph : !e.connectivity_status.connected_to_equipment_graph))
  )
  return (
    <div className="space-y-6">
      <motion.div initial="hidden" animate="visible" variants={fadeUp}>
        <PageTitle eyebrow="Equipment registry" title={`${equipment.length} identified / structured`} />
      </motion.div>

      {/* Filters */}
      <motion.div className="glass flex flex-col gap-3 p-4 md:flex-row"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
        <label className="flex flex-1 items-center gap-2 border border-slate-200 px-3">
          <Search size={15} className="text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search tag or class"
            className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-slate-400" />
        </label>
        <select value={kind} onChange={e => setKind(e.target.value)}
          className="border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
          <option value="all">All classes</option>
          {classes.map(c => <option key={c}>{c}</option>)}
        </select>
        <select value={state} onChange={e => setState(e.target.value)}
          className="border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
          <option value="all">All states</option>
          <option value="connected">Connected</option>
          <option value="isolated">Isolated</option>
        </select>
      </motion.div>

      {/* Table */}
      <motion.div className="glass overflow-hidden"
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                {['Tag', 'Class', 'YOLO conf.', 'OCR conf.', 'Ports', 'Connectivity', ''].map(x => (
                  <th key={x} className="px-4 py-3 font-semibold">{x}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => (
                <motion.tr key={e.tag}
                  className="tbl-row border-t border-slate-100"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  transition={{ delay: i * 0.03 }}>
                  <td className="px-4 py-3.5">
                    <span className="tag-mono font-semibold text-[#073d92]">{e.tag}</span>
                  </td>
                  <td className="px-4 py-3.5"><ClassPill kind={e.class} /></td>
                  <td className="px-4 py-3.5 tabular-nums text-slate-600">{format(e.detection.confidence, 3)}</td>
                  <td className="px-4 py-3.5 tabular-nums text-slate-600">{format(e.ocr.confidence, 3)}</td>
                  <td className="px-4 py-3.5 text-slate-600">{e.ports.length}</td>
                  <td className="px-4 py-3.5">
                    {e.connectivity_status.connected_to_equipment_graph
                      ? <span className="badge-connected">Connected</span>
                      : <span className="badge-isolated">Isolated</span>}
                  </td>
                  <td className="px-4 py-3.5">
                    <button onClick={() => setSelected(e)}
                      className="text-sm font-medium text-[#073d92] hover:underline">
                      Inspect
                    </button>
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>

      {selected && (
        <EquipmentDrawer
          equipment={selected}
          relations={connections.filter(c => c.equipment_a === selected.tag || c.equipment_b === selected.tag)}
          close={() => setSelected(null)} />
      )}
    </div>
  )
}

/* ─── EQUIPMENT DRAWER ───────────────────────────────────────────────────── */
function EquipmentDrawer({ equipment, relations, close }: { equipment: Equipment; relations: Connection[]; close: () => void }) {
  return (
    <AnimatePresence>
      <motion.div className="fixed inset-0 z-50 flex justify-end bg-black/40"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={close}>
        <motion.aside
          className="h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-2xl"
          initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
          transition={{ type: 'spring', stiffness: 320, damping: 35 }}
          onClick={e => e.stopPropagation()}>
          <div className="flex items-start justify-between">
            <div>
              <div className="eyebrow">Equipment detail</div>
              <h2 className="mt-2 text-2xl font-semibold text-slate-900">
                <span className="tag-mono">{equipment.tag}</span>
              </h2>
            </div>
            <button onClick={close} className="rounded p-2 text-slate-500 hover:bg-slate-100"><X size={20} /></button>
          </div>
          <div className="mt-6 space-y-4 text-sm text-slate-700">
            <Data label="Class"            value={equipment.class} />
            <Data label="BBox"             value={equipment.bbox.map(n => format(n, 1)).join(', ')} />
            <Data label="YOLO confidence"  value={format(equipment.detection.confidence, 4)} />
            <Data label="OCR confidence"   value={format(equipment.ocr.confidence, 4)} />
            <Data label="Detection ID"     value={equipment.detection.detection_id} />
            <Data label="Connectivity"     value={equipment.connectivity_status.connected_to_equipment_graph ? 'Connected' : 'Isolated'} />
            <Data label="Equipment relations" value={String(relations.length)} />
          </div>
          <div className="mt-7">
            <div className="eyebrow">Port list ({equipment.ports.length})</div>
            <div className="mt-3 space-y-2">
              {equipment.ports.map(p => (
                <div key={p.port_id} className="border border-slate-200 bg-slate-50 p-3 text-xs">
                  <strong className="tag-mono">{p.port_id}</strong>
                  <div className="mt-1 text-slate-500">
                    {p.topology_node_id} · {p.side} · geometry {format(p.geometry_confidence, 2)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.aside>
      </motion.div>
    </AnimatePresence>
  )
}

/* ─── CONNECTIVITY PAGE ──────────────────────────────────────────────────── */
function ConnectivityPage({ connections }: { connections: Connection[] }) {
  return (
    <div className="space-y-6">
      <motion.div initial="hidden" animate="visible" variants={fadeUp}>
        <PageTitle eyebrow="Equipment graph" title="Geometric connectivity"
          subtitle="Each relation is intentionally non-directional. Process-flow direction remains unresolved." />
      </motion.div>
      <motion.div className="grid gap-4 lg:grid-cols-2"
        initial="hidden" animate="visible" variants={staggerContainer}>
        {connections.map(c => (
          <motion.article key={c.connection_id} variants={fadeUp}
            className="glass p-5 transition-all duration-200 hover:border-[#073d92]/30">
            <div className="flex justify-between gap-3">
              <span className="eyebrow">{c.connection_id}</span>
              <span className="border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-700">
                Direction unresolved
              </span>
            </div>
            <div className="my-6 flex items-center gap-3 text-base font-semibold text-slate-800">
              <span className="tag-mono">{c.equipment_a}</span>
              <span className="h-px flex-1 border-t-2 border-dashed border-slate-300" />
              <span className="tag-mono">{c.equipment_b}</span>
            </div>
            <div className="flex gap-4 text-xs text-slate-500">
              <span className="uppercase tracking-wider">Medium</span>
              <span>{format(c.confidence, 3)} confidence</span>
              <span>{format(c.path.path_length_px, 0)} px path</span>
            </div>
          </motion.article>
        ))}
      </motion.div>
      <ValidationBanner />
    </div>
  )
}

/* ─── ARROWS PAGE ────────────────────────────────────────────────────────── */
function ArrowsPage({ arrows }: { arrows: FlowArrow[] }) {
  const counts = useMemo(() =>
    arrows.reduce((a, x) => ({ ...a, [x.orientation]: (a[x.orientation] || 0) + 1 }), {} as Record<string, number>),
    [arrows])
  const icons: Record<string, JSX.Element> = {
    right: <ArrowRight />, left: <ArrowLeft />, up: <ArrowUp />, down: <ArrowDown />,
  }
  return (
    <div className="space-y-6">
      <motion.div initial="hidden" animate="visible" variants={fadeUp}>
        <PageTitle eyebrow="Flow arrowheads" title={`${arrows.length} validated physical arrowheads`}
          subtitle="Arrowhead orientation is recorded separately from unresolved equipment-level process direction." />
      </motion.div>
      <motion.div className="grid gap-4 sm:grid-cols-4"
        initial="hidden" animate="visible" variants={staggerContainer}>
        {['right', 'left', 'up', 'down'].map(o => (
          <motion.div key={o} variants={fadeUp} className="glass flex items-center gap-4 p-5">
            <span className="text-[#073d92]">{icons[o]}</span>
            <div>
              <div className="display text-3xl font-semibold text-slate-900">{counts[o] || 0}</div>
              <div className="mt-1 text-xs font-semibold uppercase tracking-wider text-slate-500">{o}</div>
            </div>
          </motion.div>
        ))}
      </motion.div>
      <motion.div className="glass overflow-hidden"
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                {['Arrow ID', 'Orientation', 'X', 'Y', 'Confidence', 'Nearest Segment', 'Nearest Edge'].map(x => (
                  <th key={x} className="px-4 py-3 font-semibold">{x}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {arrows.map(a => (
                <tr key={a.arrow_id} className="tbl-row border-t border-slate-100">
                  <td className="px-4 py-3"><span className="tag-mono">{a.arrow_id}</span></td>
                  <td className="px-4 py-3 capitalize text-slate-600">{a.orientation}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">{format(a.position.x, 1)}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">{format(a.position.y, 1)}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">{format(a.confidence, 3)}</td>
                  <td className="px-4 py-3"><span className="tag-mono text-xs">{a.nearest_segment_id}</span></td>
                  <td className="px-4 py-3"><span className="tag-mono text-xs">{a.nearest_edge_id}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  )
}

/* ─── GRAPH ──────────────────────────────────────────────────────────────── */
function EquipmentNode({ data }: { data: { tag: string; className: string; isolated: boolean } }) {
  return (
    <div className="node-card" style={{ background: classColors[data.className] }}>
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <div className="tag">{data.tag}</div>
      <div className="kind">{data.className}{data.isolated ? ' · isolated' : ''}</div>
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
    </div>
  )
}
const nodeTypes = { equipment: EquipmentNode }

function GraphCanvas({ graph, equipment, onSelect }: { graph: Graph; equipment: Equipment[]; onSelect: (e: Equipment) => void }) {
  const { fitView } = useReactFlow()
  const [showIsolated, setShowIsolated] = useState(true)
  const positions: Record<string, [number, number]> = {
    '230A-PB-01': [70, 30],   '230A-SP-01D': [70, 150],  '230A-SP-01S': [70, 270],
    '230A-PB-02': [360, 30],  '230A-SP-02D': [360, 150], '230A-SP-02S': [360, 270],
    '230A-SA-02': [360, 390], '230A-PB-04': [650, 30],   '230A-SP-04D': [650, 150],
    '230A-SP-04S': [650, 270],'230A-CY-01': [40, 560],   '230A-CY-02': [210, 560],
    '230A-SA-01': [380, 560], '230A-SA-03': [550, 560],  '230A-SA-04': [720, 560],
    '230A-VP-01': [890, 560],
  }
  const nodes: Node[] = graph.nodes
    .filter(n => showIsolated || n.connectivity_status.connected_to_equipment_graph)
    .map(n => ({
      id: n.id, type: 'equipment',
      position: { x: positions[n.id]?.[0] ?? 0, y: positions[n.id]?.[1] ?? 0 },
      data: { tag: n.tag, className: n.class, isolated: !n.connectivity_status.connected_to_equipment_graph },
    }))
  const edges: Edge[] = graph.edges.map(e => ({
    id: e.id, source: e.source, target: e.target, type: 'straight',
    animated: false, label: 'Unknown flow direction',
    labelStyle: { fill: '#64748b', fontSize: 10 },
    style: { stroke: '#93c5fd', strokeDasharray: '7 5', strokeWidth: 1.5 },
  }))

  useEffect(() => { fitView({ padding: 0.18, duration: 600 }) }, [fitView])

  return (
    <div className="glass h-[670px] overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <span className="eyebrow">Interactive equipment graph</span>
          <span className="ml-3 text-xs text-slate-400">Dashed = direction unknown</span>
        </div>
        <div className="flex gap-2">
          {[
            ['Fit view',  () => fitView({ padding: .18, duration: 350 })],
            ['Reset',     () => fitView({ padding: .18, duration: 0 })],
            [showIsolated ? 'Hide isolated' : 'Show isolated', () => setShowIsolated(!showIsolated)],
          ].map(([label, onClick]) => (
            <button key={String(label)} onClick={onClick as () => void}
              className="border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-[#073d92]/40 hover:text-[#073d92]">
              {String(label)}
            </button>
          ))}
        </div>
      </div>
      <div className="h-[615px]">
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView
          onNodeClick={(_, node) => { const e = equipment.find(x => x.tag === node.id); if (e) onSelect(e) }}
          onEdgeClick={(_, edge) => alert(`${edge.id}\nDirection: unknown\nRequires validation: true`)}>
          <Background color="#e2e8f0" gap={24} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable
            nodeColor={n => classColors[(n.data as { className: string }).className] ?? '#567'} />
        </ReactFlow>
      </div>
    </div>
  )
}

function GraphPage({ graph, equipment }: { graph: Graph; equipment: Equipment[] }) {
  const [selected, setSelected] = useState<Equipment | null>(null)
  const connections = graph.edges.map(e => ({ equipment_a: e.source, equipment_b: e.target } as Connection))
  return (
    <div className="space-y-6">
      <motion.div initial="hidden" animate="visible" variants={fadeUp}>
        <PageTitle eyebrow="Graph workspace" title="PFD-230 equipment topology"
          subtitle="The relation arrow in the technical graph is not a claim about fluid direction." />
      </motion.div>
      <ReactFlowProvider>
        <GraphCanvas graph={graph} equipment={equipment} onSelect={setSelected} />
      </ReactFlowProvider>
      {selected && (
        <EquipmentDrawer
          equipment={selected}
          relations={connections.filter(c => c.equipment_a === selected.tag || c.equipment_b === selected.tag)}
          close={() => setSelected(null)} />
      )}
      <ValidationBanner />
    </div>
  )
}

/* ─── JSON PAGE ──────────────────────────────────────────────────────────── */
function JsonPage({ raw }: { raw: unknown }) {
  const text = JSON.stringify(raw, null, 2)
  const [copied, setCopied] = useState(false)
  const copy = async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400) }
  const download = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    a.download = 'pfd230_final.json'; a.click(); URL.revokeObjectURL(a.href)
  }
  return (
    <div className="space-y-5">
      <motion.div initial="hidden" animate="visible" variants={fadeUp}>
        <PageTitle eyebrow="Structured output" title="pfd230_final.json"
          subtitle="The frozen JSON is displayed directly from the FastAPI data source." />
      </motion.div>
      <div className="flex gap-2">
        <button onClick={copy}
          className="inline-flex items-center gap-2 border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-[#073d92]/40 hover:text-[#073d92]">
          <Copy size={15} />
          <AnimatePresence mode="wait">
            {copied
              ? <motion.span key="c" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>Copied!</motion.span>
              : <motion.span key="n" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>Copy JSON</motion.span>}
          </AnimatePresence>
        </button>
        <button onClick={download}
          className="inline-flex items-center gap-2 bg-[#073d92] px-4 py-2 text-sm font-bold text-white transition hover:bg-[#062f71]">
          <Download size={15} /> Download JSON
        </button>
      </div>
      <pre className="max-h-[720px] overflow-auto border border-slate-200 bg-slate-900 p-5 text-xs leading-6 text-green-300">
        <code>{text}</code>
      </pre>
    </div>
  )
}

/* ─── SMALL COMPONENTS ───────────────────────────────────────────────────── */
function Pipeline({ statuses }: { statuses: string[] }) {
  return (
    <div>
      <div className="eyebrow">Pipeline status</div>
      <div className="mt-4 grid gap-1">
        {statuses.map((s, i) => (
          <div key={s} className="flex items-center justify-between border-b border-slate-100 py-2.5 text-sm">
            <span>
              <span className="mr-3 text-xs font-bold tabular-nums text-slate-400">{String(i + 1).padStart(2, '0')}</span>
              {s}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-green-600">
              <CheckCircle2 size={13} /> completed
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function DataQuality({ summary }: { summary: Summary }) {
  return (
    <section className="border border-amber-200 bg-amber-50 p-6">
      <div className="eyebrow text-amber-700">Requires validation</div>
      <h2 className="mt-3 text-xl font-semibold text-slate-900">
        The system preserves uncertainty instead of inventing results.
      </h2>
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {([
          [summary.unresolved_crossings,   'Unresolved line crossings'],
          [summary.unknown_edge_directions,'Topology edges with unknown direction'],
          [summary.process_connections,    'Equipment relations with unresolved direction'],
          [summary.isolated_equipment,     'Isolated equipment'],
          [1,                              `Unassociated YOLO detection: ${summary.unassociated_yolo_detection}`],
        ] as [number, string][]).map(([n, l]) => (
          <div key={l} className="border-l-2 border-amber-400 pl-3">
            <strong className="block text-2xl font-bold text-amber-700">{n}</strong>
            <span className="text-xs text-slate-600">{l}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function ValidationBanner() {
  return (
    <div className="flex items-start gap-3 border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
      <span>
        All eight equipment-level geometric relations have <strong>direction = unknown</strong>,{' '}
        <strong>confidence level = MEDIUM</strong> and <strong>require validation</strong>.
        No process-flow direction is shown.
      </span>
    </div>
  )
}

function PageTitle({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) {
  return (
    <div>
      <div className="eyebrow">{eyebrow}</div>
      <h2 className="display mt-3 text-4xl font-semibold text-white">{title}</h2>
      {subtitle && <p className="mt-3 max-w-2xl text-slate-300">{subtitle}</p>}
    </div>
  )
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: 'warn' }) {
  return (
    <div className={`stat-card ${tone ? 'stat-card-warn' : ''}`}>
      <div className={`display text-5xl font-bold tracking-[-.05em] ${tone ? 'text-amber-600' : 'text-[#073d92]'}`}>
        {format(value)}
      </div>
      <div className="mt-3 text-xs font-semibold uppercase tracking-[.12em] text-slate-500">{label}</div>
    </div>
  )
}

function MetricLink({ value, label, onClick }: { value: number; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="glass p-5 text-left transition-all duration-200 hover:border-[#073d92]/30 hover:shadow-md">
      <strong className="display block text-4xl font-bold text-[#073d92]">{value}</strong>
      <span className="mt-2 block text-xs font-semibold uppercase tracking-[.12em] text-slate-500">{label}</span>
    </button>
  )
}

function Data({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm text-slate-800">{value}</dd>
    </div>
  )
}

function ClassPill({ kind }: { kind: string }) {
  return (
    <span style={{ borderColor: classColors[kind], color: classColors[kind] }}
      className="inline-block border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
      {kind}
    </span>
  )
}

function Loading() {
  return (
    <div className="grid min-h-[70vh] place-items-center">
      <motion.div className="text-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <div className="eyebrow">PFD Intelligence</div>
        <div className="mt-3 flex items-center gap-2 text-lg text-slate-600">
          <Loader2 size={18} className="animate-spin text-[#073d92]" />
          Chargement des données de l’exemple…
        </div>
      </motion.div>
    </div>
  )
}

function ErrorState({ error }: { error: string }) {
  return (
    <div className="mx-auto max-w-2xl px-5 py-28">
      <motion.div className="border border-red-200 bg-red-50 p-6"
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="eyebrow text-red-700">Connexion requise</div>
        <h1 className="mt-3 text-2xl font-semibold text-slate-900">L’API PFD Intelligence est indisponible.</h1>
        <p className="mt-3 text-sm text-slate-600">{error}</p>
      </motion.div>
    </div>
  )
}

function Footer({ demo }: { demo: boolean }) {
  return (
    <footer className="border-t border-slate-200 bg-white px-5 py-8 text-center text-xs text-slate-400">
      <div className="mx-auto max-w-7xl flex flex-col items-center gap-1">
        <span className="font-semibold uppercase tracking-[.15em] text-slate-500">JESA Engineering · PFD Intelligence</span>
        <span>{demo ? 'Espace de démonstration PFD-230' : 'Espace d’analyse de PDF téléversés'} · incertitude préservée par conception · {new Date().getFullYear()}</span>
      </div>
    </footer>
  )
}

export default App
