import { Component, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './styles.css'
import App from './App'

class ApplicationErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : 'Erreur JavaScript inconnue' }
  }

  render() {
    if (this.state.error) {
      return <main className="min-h-screen bg-[#f3f5f7] px-5 py-24 text-[#142b4f]">
        <section className="mx-auto max-w-xl border border-red-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[.18em] text-red-700">Erreur d’affichage</p>
          <h1 className="mt-3 text-3xl font-semibold">La page n’a pas pu être chargée.</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">{this.state.error}</p>
          <button className="mt-6 bg-[#073d92] px-5 py-3 font-bold text-white" onClick={() => location.reload()}>Recharger l’application</button>
        </section>
      </main>
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ApplicationErrorBoundary><App /></ApplicationErrorBoundary>,
)
