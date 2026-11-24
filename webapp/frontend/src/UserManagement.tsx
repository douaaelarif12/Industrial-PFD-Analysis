import {useEffect,useState} from 'react'
import {api} from './api'
type User={id:string;name:string;email:string;role:string;active:number}
export function UserManagement(){
  const [items,setItems]=useState<User[]>([]);const [error,setError]=useState('');const [busy,setBusy]=useState(false)
  const [editing,setEditing]=useState<User|null>(null);const [show,setShow]=useState(false)
  const [name,setName]=useState('');const [email,setEmail]=useState('');const [password,setPassword]=useState('');const [role,setRole]=useState('user')
  const load=async()=>setItems((await api<{items:User[]}>('/api/users')).items)
  useEffect(()=>{void load().catch(e=>setError(e.message))},[])
  const update=async(path:string,payload:unknown,method:string)=>{
    setBusy(true);setError('')
    try{await api(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});await load();setShow(false)}catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  const form=(user:User|null)=>{setEditing(user);setName(user?.name||'');setEmail(user?.email||'');setRole(user?.role||'user');setPassword('');setShow(true)}
  return <section className="mx-auto max-w-6xl space-y-6 p-8"><div className="flex justify-between"><h1 className="text-3xl font-bold">Utilisateurs</h1><button className="rounded bg-[#073d92] px-4 py-2 text-white" onClick={()=>form(null)}>Créer un utilisateur</button></div>
    {error&&<p role="alert" className="bg-red-50 p-4 text-red-700">{error}</p>}
    {show&&<form className="glass grid max-w-2xl gap-4 p-6" onSubmit={e=>{e.preventDefault();void update(editing?'/api/users/'+editing.id:'/api/users',{name,email,role,...(password?{password}:{})},editing?'PUT':'POST')}}>
      <h2 className="text-xl font-semibold">{editing?'Modifier le compte':'Nouveau compte'}</h2>
      <label>Nom complet<input required className="mt-1 block w-full border p-2" value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>E-mail<input required type="email" className="mt-1 block w-full border p-2" value={email} onChange={e=>setEmail(e.target.value)}/></label>
      <label>Rôle<select className="mt-1 block w-full border p-2" value={role} onChange={e=>setRole(e.target.value)}><option value="user">Utilisateur</option><option value="admin">Administrateur</option></select></label>
      <label>{editing?'Nouveau mot de passe (facultatif)':'Mot de passe temporaire'}<input type="password" minLength={8} required={!editing} autoComplete="new-password" className="mt-1 block w-full border p-2" value={password} onChange={e=>setPassword(e.target.value)}/></label>
      <div className="flex gap-4"><button disabled={busy} className="rounded bg-[#073d92] px-4 py-2 text-white">Enregistrer</button><button type="button" onClick={()=>setShow(false)}>Annuler</button></div>
    </form>}
    <div className="glass overflow-x-auto p-4"><table className="w-full text-left text-sm"><thead><tr>{['Nom','E-mail','Rôle','Statut','Actions'].map(t=><th key={t} className="p-3">{t}</th>)}</tr></thead><tbody>{items.map(u=><tr key={u.id} className="border-t"><td className="p-3">{u.name}</td><td>{u.email}</td><td>{u.role==='admin'?'Administrateur':'Utilisateur'}</td><td>{u.active?'Actif':'Désactivé'}</td><td className="space-x-3"><button onClick={()=>form(u)}>Modifier</button><button disabled={busy} onClick={()=>void update('/api/users/'+u.id,{active:u.active?0:1},'PUT')}>{u.active?'Désactiver':'Activer'}</button></td></tr>)}</tbody></table></div>
  </section>
}
